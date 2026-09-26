import { API_BASE } from "../demo/config.js";
import { initAnalytics, track } from "../src/analytics.js";

void initAnalytics();

const POSITION_POLL_MS = 30_000;
const ETA_FALLBACK_TEXT = "Usually a few minutes while the generator is online.";

let ticketToken = null;
let pollTimer = null;
let pollInFlight = false;
let lastState = null;
let resultOpenedTracked = false;

function byId(id) {
  return typeof document === "undefined" ? null : document.getElementById(id);
}

function normalizeToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/u.test(token) ? token : null;
}

function tokenFromHash(hash) {
  if (typeof hash !== "string") return null;
  const source = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return normalizeToken(new URLSearchParams(source).get("t"));
  } catch {
    return null;
  }
}

function currentLocation() {
  try {
    return new URL(globalThis.location.href);
  } catch {
    return null;
  }
}

function readToken() {
  const url = currentLocation();
  if (!url) return null;
  if (url.searchParams.has("t")) {
    const queryToken = normalizeToken(url.searchParams.get("t"));
    url.searchParams.delete("t");
    const query = url.searchParams.toString();
    const next = `${url.pathname}${query ? `?${query}` : ""}${queryToken ? `#t=${encodeURIComponent(queryToken)}` : ""}`;
    try {
      globalThis.history?.replaceState(null, "", next);
    } catch {
      // History can be unavailable in embedded or restricted documents.
    }
    return queryToken;
  }
  return tokenFromHash(url.hash);
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value == null ? "" : String(value);
  return element;
}

function show(id, visible) {
  const element = byId(id);
  if (element) element.classList.toggle("is-hidden", !visible);
  return element;
}

function setMessage(message) {
  setText("ticket-message", message);
}

function renderPrompt(text) {
  const element = byId("ticket-prompt");
  if (!element) return;
  element.textContent = typeof text === "string" ? text : "";
  element.hidden = !element.textContent;
}

function resetActions() {
  show("open-result", false);
  show("copy-link", false);
  show("ticket-result", false);
}

function renderQueued(state) {
  setText("ticket-state-title", "Queued");
  const position = Number(state?.position);
  setText("ticket-position", Number.isInteger(position) && position > 0 ? `You are #${position} in line` : "You are in line");
  const etaMinutes = Number(state?.etaMinutes);
  const hasMinutes = state?.etaMinutes !== null && state?.etaMinutes !== undefined && Number.isFinite(etaMinutes) && etaMinutes >= 0;
  const suppliedEta = typeof state?.etaText === "string" ? state.etaText.trim() : "";
  if (hasMinutes) {
    setText("ticket-eta", suppliedEta || `About ${etaMinutes} minute${etaMinutes === 1 ? "" : "s"}`);
  } else {
    // Do not display a stale numeric estimate when the API has withdrawn it.
    const hasStaleEstimate = /\b\d+\s+minutes?\b/iu.test(suppliedEta)
      || /^Usually within a few hours\s+(?:—|-)\s+at most 48 hours\.$/iu.test(suppliedEta);
    setText("ticket-eta", hasStaleEstimate ? ETA_FALLBACK_TEXT : (suppliedEta || ETA_FALLBACK_TEXT));
  }
  resetActions();
  show("copy-link", true);
  setMessage("");
}

function renderRunning(state = null) {
  setText("ticket-state-title", "Running");
  setText("ticket-position", "Your motion is being prepared.");
  setText("ticket-eta", "The generator is working on it now.");
  resetActions();
  show("copy-link", true);
  setMessage("");
}

function renderDone(state) {
	if (!resultOpenedTracked) {
		resultOpenedTracked = true;
		track("hosted:result_opened");
	}
  setText("ticket-state-title", "Ready");
  setText("ticket-position", "Your motion is ready.");
  setText("ticket-eta", "Open it in CozyClay to play it back.");
  resetActions();
  renderPrompt(state?.promptText);
  const resultUrl = typeof state?.resultUrl === "string" ? state.resultUrl : "";
  const open = byId("open-result");
  if (open && resultUrl) {
    open.href = `/app/?motion=${encodeURIComponent(resultUrl)}`;
    show("open-result", true);
  }
  show("copy-link", true);
  show("ticket-result", true);
  setMessage("");
}

function renderFailed(state = null) {
  setText("ticket-state-title", "Could not complete");
  setText("ticket-position", "This motion failed.");
  setText("ticket-eta", "No charge was made. You can create another motion.");
  resetActions();
  setMessage("");
}

function renderRevoked(state = null) {
  setText("ticket-state-title", "Ticket unavailable");
  setText("ticket-position", "This ticket has been revoked.");
  setText("ticket-eta", "The result link is no longer active.");
  resetActions();
  setMessage("");
}

function renderExpired(state = null) {
  setText("ticket-state-title", "Ticket expired");
  setText("ticket-position", "This link has expired.");
  setText("ticket-eta", "Results are kept for 30 days.");
  resetActions();
  setMessage("");
}

function renderNotFound() {
  setText("ticket-state-title", "Ticket not found");
  setText("ticket-position", "We could not find that ticket.");
  setText("ticket-eta", "Check the link and try again.");
  renderPrompt("");
  resetActions();
  setMessage("");
}

function renderState(state) {
  renderPrompt(state?.promptText);
  switch (state?.status) {
    case "queued":
      renderQueued(state);
      break;
    case "running":
      renderRunning(state);
      break;
    case "done":
      renderDone(state);
      break;
    case "failed":
      renderFailed(state);
      break;
    case "revoked":
    case "canceled":
      renderRevoked(state);
      break;
    default:
      setText("ticket-state-title", "Ticket unavailable");
      setText("ticket-position", "We could not read this ticket.");
      setText("ticket-eta", "Please return to the composer and try again.");
      resetActions();
      setMessage("");
  }
}

function terminalStatus(status) {
  return status === "done" || status === "failed" || status === "revoked" || status === "canceled";
}

function stopPolling() {
  if (pollTimer !== null) {
    globalThis.clearInterval?.(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (pollTimer === null) pollTimer = globalThis.setInterval(poll, POSITION_POLL_MS);
}

async function readResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function fetchTicket(ticketToken) {
  return fetch(`${API_BASE}/jobs/${encodeURIComponent(ticketToken)}`, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
}

async function poll() {
  if (!ticketToken || pollInFlight) return null;
  pollInFlight = true;
  try {
    const response = await fetchTicket(ticketToken);
    const data = await readResponse(response);
    if (response.status === 404 || data.error === "not_found") {
      renderNotFound();
      stopPolling();
      return data;
    }
    if (response.status === 410) {
      if (data.error === "expired") renderExpired();
      else renderRevoked();
      stopPolling();
      return data;
    }
    if (!response.ok) throw new Error(data.error || "poll_failed");
    lastState = data;
    renderState(data);
    if (terminalStatus(data.status)) stopPolling();
    else startPolling();
    return data;
  } catch {
    if (!lastState) {
      setText("ticket-state-title", "Connection problem");
      setText("ticket-position", "We could not reach the queue.");
      setText("ticket-eta", "We will keep trying.");
    }
    setMessage("The latest update did not arrive. We will try again shortly.");
    startPolling();
    return null;
  } finally {
    pollInFlight = false;
  }
}

async function copyShareLink() {
  const shareUrl = globalThis.location?.href ?? "";
  if (!shareUrl) return;
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(shareUrl);
    } else {
      const input = document.createElement("input");
      input.value = shareUrl;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setMessage("Share link copied.");
  } catch {
    setMessage("Copy was not available. Copy the link from your address bar.");
  }
}

function onVisibilityChange() {
  if (typeof document !== "undefined" && document.visibilityState === "visible") poll();
}

function bindTicket() {
	byId("copy-link")?.addEventListener("click", copyShareLink);
	byId("open-result")?.addEventListener("click", () => track("hosted:opened_in_studio"));
  if (ticketToken) {
    const report = byId("report-link");
    if (report) report.href = `mailto:hello@cozyclay.org?subject=${encodeURIComponent(`CozyClay ticket ${ticketToken}`)}`;
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function boot() {
  ticketToken = readToken();
  bindTicket();
  if (!ticketToken) {
    renderNotFound();
    return;
  }
  poll();
  startPolling();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}

export {
  API_BASE,
  POSITION_POLL_MS,
  fetchTicket,
  onVisibilityChange,
  poll,
  readToken,
  renderDone,
  renderFailed,
  renderState,
  renderPrompt,
  renderQueued,
  renderRevoked,
};
