import { API_BASE, DEMO_DISABLED, TURNSTILE_SITE_KEY, configuredPromptLimit } from "./config.js";
import { initAnalytics, track } from "../src/analytics.js";

void initAnalytics().then(() => track("hosted:composer_viewed"));

const DISABLED_MESSAGE = "아직 동작하지 않는 기능입니다. This feature is not available yet.";

const PROMPT_STORAGE_KEY = "cozyclay.demo.prompt";

const ERROR_MESSAGES = Object.freeze({
  active_job_exists: "You already have a motion in progress. Follow that ticket before starting another.",
  daily_cap: "You have reached today's motion limit. Please come back tomorrow.",
  queue_full: "The queue is full right now. Please try again in a little while.",
  turnstile_failed: "The security check could not be verified. Complete it again and try once more.",
  signed_in_required: "Sign in before creating a motion.",
  invalid_prompt: "Enter a motion prompt within the allowed character limit.",
  submissions_disabled: "New submissions are paused for maintenance. Please try again later.",
});

let sessionState = { signedIn: false, activeJobToken: null, sessionError: false, sessionChecked: false };
let turnstileWidgetId = null;
let turnstileToken = "";
let turnstileLoadListenerAttached = false;
let submitInFlight = false;

const SUBMIT_LABEL = "Create motion";
const SIGN_IN_SUBMIT_LABEL = "Continue with Google to create";

function byId(id) {
  return typeof document === "undefined" ? null : document.getElementById(id);
}

function promptLimit(field = byId("prompt")) {
  const limit = Number(field?.maxLength);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : configuredPromptLimit;
}

function errorMessageFor(code) {
  return ERROR_MESSAGES[code] || "We could not create that motion. Please try again.";
}

function renderSessionError(message = "") {
  const notice = byId("session-notice");
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = !message;
}

function safeStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function savePrompt(value) {
  const storage = safeStorage();
  if (!storage) return;
  try {
    if (value) storage.setItem(PROMPT_STORAGE_KEY, value);
    else storage.removeItem(PROMPT_STORAGE_KEY);
  } catch {
    // Private browsing can deny storage; the form still works for this visit.
  }
}

function restorePrompt() {
  const field = byId("prompt");
  const storage = safeStorage();
  if (!field || !storage) return;
  try {
    const saved = storage.getItem(PROMPT_STORAGE_KEY);
    if (saved && !field.value) field.value = saved.slice(0, promptLimit(field));
  } catch {
    // Ignore unavailable session storage.
  }
  updatePromptCount();
}

function updatePromptCount() {
  const field = byId("prompt");
  const count = byId("prompt-count");
  if (!field || !count) return;
  const limit = promptLimit(field);
  count.textContent = `${Math.max(0, limit - field.value.length)} characters left`;
}

function setMessage(message, { activeToken = null } = {}) {
  const target = byId("form-message");
  if (!target) return;
  target.replaceChildren();
  if (!message) return;
  target.append(document.createTextNode(message));
  if (activeToken) {
    const link = document.createElement("a");
    link.href = `/d/?t=${encodeURIComponent(activeToken)}`;
    link.textContent = " Open your current ticket.";
    target.append(link);
  }
}

function setTurnstileStatus(message, isError = false) {
  const status = byId("turnstile-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function resetTurnstile() {
  turnstileToken = "";
  try {
    if (globalThis.turnstile?.reset) {
      if (turnstileWidgetId !== null) globalThis.turnstile.reset(turnstileWidgetId);
      else globalThis.turnstile.reset();
    }
  } catch {
    // A widget can disappear while a navigation is in progress.
  }
  setTurnstileStatus("Complete the check before submitting.");
}

function mountTurnstile() {
  if (!sessionState.sessionChecked || !sessionState.signedIn || sessionState.sessionError) return;
  const widget = byId("turnstile-widget");
  if (!widget || turnstileWidgetId !== null) return;
  if (!TURNSTILE_SITE_KEY) {
    setTurnstileStatus("The security check is not configured for this build.", true);
    return;
  }
  widget.dataset.sitekey = TURNSTILE_SITE_KEY;
  const render = () => {
    if (
      !sessionState.sessionChecked
      || !sessionState.signedIn
      || sessionState.sessionError
      || !globalThis.turnstile?.render
      || turnstileWidgetId !== null
    ) return;
    try {
      turnstileWidgetId = globalThis.turnstile.render(widget, {
        sitekey: TURNSTILE_SITE_KEY,
        callback(token) {
          turnstileToken = typeof token === "string" ? token : "";
          setTurnstileStatus(turnstileToken ? "Security check complete." : "Complete the check before submitting.");
        },
        "expired-callback": () => {
          turnstileToken = "";
          setTurnstileStatus("The security check expired. Please complete it again.", true);
        },
        "error-callback": () => {
          turnstileToken = "";
          setTurnstileStatus("The security check could not load. Try refreshing the page.", true);
        },
      });
    } catch {
      setTurnstileStatus("The security check could not load. Try refreshing the page.", true);
    }
  };
  if (globalThis.turnstile?.render) render();
  else if (!turnstileLoadListenerAttached) {
    const script = byId("turnstile-script");
    if (script) {
      turnstileLoadListenerAttached = true;
      script.addEventListener("load", render, { once: true });
    }
  }
}

function updateSubmitButton() {
  const button = byId("submit-job");
  if (!button) return;
  if (submitInFlight) {
    button.textContent = "Creating…";
    return;
  }
  const signInFirst = sessionState.sessionChecked && !sessionState.sessionError && !sessionState.signedIn;
  button.textContent = signInFirst ? SIGN_IN_SUBMIT_LABEL : SUBMIT_LABEL;
}

function updateSessionUi(session, { sessionError = false, sessionChecked = true } = {}) {
  sessionState = session && typeof session === "object"
    ? { ...session, sessionError, sessionChecked }
    : { signedIn: false, activeJobToken: null, sessionError, sessionChecked };
  const status = byId("session-status");
  const panel = byId("sign-in-panel");
  if (status) {
    status.classList.toggle("is-signed-in", Boolean(sessionState.signedIn));
    if (!sessionChecked) {
      status.textContent = "Checking your session…";
    } else if (sessionError) {
      status.textContent = "Sign-in status unavailable";
    } else if (sessionState.signedIn) {
      const provider = typeof sessionState.provider === "string" ? sessionState.provider.toLowerCase() : "";
      const identity = provider === "google" ? "Signed in with Google" : "Signed in";
      const remaining = Number.isFinite(Number(sessionState.dailyRemaining))
        ? ` · ${Math.max(0, Number(sessionState.dailyRemaining))} left today`
        : "";
      status.textContent = `${identity}${remaining}`;
    } else {
      status.textContent = "Not signed in";
    }
  }
  panel?.classList.toggle("is-hidden", Boolean(sessionState.signedIn));
  const turnstileWrap = byId("turnstile-wrap")
    || (typeof document !== "undefined" ? document.querySelector?.(".turnstile-wrap") : null);
  turnstileWrap?.classList.toggle(
    "is-hidden",
    !(sessionState.sessionChecked && sessionState.signedIn && !sessionState.sessionError),
  );
  updateSubmitButton();
  if (sessionState.sessionChecked && sessionState.signedIn && !sessionState.sessionError) mountTurnstile();
  renderSessionError(sessionError ? "We could not check your sign-in status. Please try again in a moment." : "");
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error("invalid_json", { cause: error });
  }
}

async function getSession() {
  updateSessionUi(sessionState, { sessionError: false, sessionChecked: false });
  try {
    const response = await fetch(`${API_BASE}/me`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 401) {
      let data = {};
      try {
        data = await responseJson(response);
      } catch {
        // A 401 is still an authentication result when its body is malformed.
      }
      updateSessionUi({ ...data, signedIn: false, activeJobToken: data?.activeJobToken ?? null });
      return data;
    }
    const data = await responseJson(response);
    if (response.ok && data?.signedIn === false) {
      updateSessionUi({ ...data, signedIn: false, activeJobToken: data?.activeJobToken ?? null });
      return data;
    }
    if (!response.ok || typeof data?.signedIn !== "boolean") {
      throw new Error(data?.error || "session_unavailable");
    }
    updateSessionUi(data);
    return data;
  } catch {
    updateSessionUi(sessionState, { sessionError: true });
    return null;
  }
}

function returnPath() {
  const path = globalThis.location?.pathname;
  return path && /^\/demo(?:\/|$)/u.test(path) ? `${path}${globalThis.location.search || ""}` : "/demo/";
}

function signIn(provider, promptValue) {
	if (provider !== "google") return;
	track("hosted:login_started");
  const field = byId("prompt");
  if (typeof promptValue === "string") savePrompt(promptValue);
  else if (field) savePrompt(field.value ?? "");
  const next = encodeURIComponent(returnPath());
  location.href = `${API_BASE}/auth/${provider}/start?next=${next}`;
}

function setSubmitBusy(busy) {
  submitInFlight = busy;
  const button = byId("submit-job");
  if (!button) return;
  button.disabled = busy;
  if (busy) button.textContent = "Creating…";
  else updateSubmitButton();
}

function turnstileResponse() {
  if (turnstileToken) return turnstileToken;
  try {
    if (globalThis.turnstile?.getResponse) {
      return (turnstileWidgetId === null
        ? globalThis.turnstile.getResponse()
        : globalThis.turnstile.getResponse(turnstileWidgetId)) || "";
    }
  } catch {
    // Treat an unavailable response as an empty token.
  }
  return "";
}

function redirectToTicket(token) {
  if (typeof token !== "string" || !token) {
    setMessage("The API accepted the job but did not return a ticket. Please try again.");
    return;
  }
  savePrompt("");
  location.href = "/d/?t=" + encodeURIComponent(token);
}

async function submit({ prompt: suppliedPrompt, turnstileToken: suppliedToken } = {}) {
  if (submitInFlight) return null;
  const field = byId("prompt");
  const prompt = typeof suppliedPrompt === "string" ? suppliedPrompt : field?.value ?? "";
  const cleanPrompt = prompt.trim();
  const token = typeof suppliedToken === "string" && suppliedToken ? suppliedToken : turnstileResponse();
  setMessage("");

  if (!sessionState.sessionChecked) {
    setMessage("We are still checking your sign-in status. Please try again in a moment.");
    return null;
  }
  if (sessionState.sessionError) {
    setMessage("We could not check your sign-in status. Please try again in a moment.");
    return null;
  }
  if (!sessionState.signedIn) {
    if (field && typeof suppliedPrompt === "string") field.value = prompt;
    savePrompt(prompt);
    signIn("google");
    return null;
  }
  if (!cleanPrompt || cleanPrompt.length > promptLimit(field)) {
    setMessage(errorMessageFor("invalid_prompt"));
    return null;
  }
  if (!token) {
    setMessage(ERROR_MESSAGES.turnstile_failed);
    setTurnstileStatus("Complete the check before submitting.", true);
    return null;
  }

  setSubmitBusy(true);
  try {
    const response = await fetch(`${API_BASE}/jobs`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ prompt: cleanPrompt, turnstileToken: token }),
    });
    const data = await responseJson(response);
    if (response.status === 201) {
		track("hosted:ticket_created");
      redirectToTicket(data.token);
      return data;
    }
    const code = typeof data.error === "string" ? data.error : "";
    if (code === "active_job_exists") {
      setMessage(ERROR_MESSAGES[code], { activeToken: data.activeJobToken || sessionState.activeJobToken });
    } else {
      setMessage(errorMessageFor(code));
    }
    if (code === "signed_in_required") {
      sessionState = { ...sessionState, signedIn: false };
      updateSessionUi(sessionState);
      savePrompt(prompt);
    }
    if (code === "turnstile_failed") resetTurnstile();
    return data;
  } catch {
    setMessage("We could not reach the queue. Check your connection and try again.");
    return null;
  } finally {
    setSubmitBusy(false);
  }
}

function bindComposer() {
  const field = byId("prompt");
  field?.addEventListener("input", updatePromptCount);
  byId("job-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  document.querySelectorAll("[data-provider]").forEach((button) => {
    button.addEventListener("click", () => signIn(button.dataset.provider));
  });
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = byId("prompt");
      const value = button.dataset?.prompt;
      if (!field || typeof value !== "string") return;
      field.value = value;
      updatePromptCount();
      savePrompt(value);
    });
  });
}

/** Preview lock: every actionable control answers with the notice instead. */
function bindDisabledComposer() {
  byId("job-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    setMessage(DISABLED_MESSAGE);
  });
  document.querySelectorAll("[data-provider], [data-prompt]").forEach((button) => {
    button.addEventListener("click", () => setMessage(DISABLED_MESSAGE));
  });
}

function bootDisabled() {
  const status = byId("session-status");
  if (status) status.textContent = "Preview";
  renderSessionError(DISABLED_MESSAGE);
  byId("turnstile-widget")?.closest(".turnstile-wrap")?.classList.add("is-hidden");
  bindDisabledComposer();
}

function boot() {
  if (DEMO_DISABLED) {
    bootDisabled();
    return;
  }
  const field = byId("prompt");
  if (field) field.maxLength = configuredPromptLimit;
  restorePrompt();
  bindComposer();
  getSession();
}

function getSessionState() {
  return { ...sessionState };
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}

export {
  API_BASE,
  ERROR_MESSAGES,
  errorMessageFor,
  getSession,
  getSessionState,
  promptLimit,
  signIn,
  submit,
  updateSessionUi,
};
