import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FiAlertTriangle, FiCheck, FiChevronRight, FiClock, FiDownload, FiImage, FiMoreHorizontal, FiPaperclip, FiPlus, FiRotateCw, FiX } from "react-icons/fi";
import {
	ATTACHMENT_FAILED_NOTICE,
	ATTACHMENT_LIMIT_NOTICE,
	ATTACHMENT_TYPE_NOTICE,
	attachmentFilesFromTransfer,
	attachmentFromFile,
	transferCarriesFiles,
} from "./attachment-image.js";
import {
	AGENT_PANEL_OVERLAY_BREAKPOINT,
	AGENT_PANEL_RAIL_WIDTH,
	AGENT_PANEL_WIDTH_MAX,
	AGENT_PANEL_WIDTH_MIN,
	AGENT_STATES,
	describeActivity,
	JOB_STATE_COPY,
	createAgentChatStore,
	effortOptions,
	ERROR_COPY,
	formatJobProgress,
	isTerminalJobState,
	jobStateTone,
	modelIsSelectable,
	nextSelectedModel,
	AGENT_PANEL_WIDTH_DEFAULT,
	clampPanelWidth,
	createAgentTransport,
	panelPresentation,
	providerEnvLabel,
	requestHostImageAction,
	resolveToolLabel,
	formatElapsed,
	formatResetIn,
	readStoredPanelWidth,
	storeModel,
	storePanelWidth,
	STUDIO_SESSION_STORAGE_KEY,
} from "./agent-client.js";
import "./agent-panel.css";

function relativeTime(value, now = Date.now()) {
	const at = Date.parse(value || "");
	if (!Number.isFinite(at)) return "just now";
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function StatusDot({ tone, title }) {
	return <span className={`agent-status-dot ${tone}`} title={title} aria-hidden="true" />;
}

function ToolCallCard({ call, presentation, onRetry }) {
	const tone = call.status === "running" ? "busy" : ["failed", "cancelled"].includes(call.status) ? "alert" : "ok";
	// The badge marks a call that edits the host surface, so it is drawn exactly
	// for the families that surface names.
	const hostTool = Object.hasOwn(presentation.toolLabels, call.name);
	const detail = call.error ? `error: ${call.error}` : JSON.stringify(call.result ?? call.args ?? {}, null, 2);
	return <div className={`agent-card agent-tool-card${call.status === "failed" ? " failed" : ""}`} data-tool-status={call.status} data-tool-name={call.name}>
		<details>
			<summary>
				<StatusDot tone={tone} title={call.status} />
				<span className="agent-tool-label">{resolveToolLabel(call, presentation.toolLabels)}</span>{hostTool && <span className="agent-tool-badge">{presentation.toolBadge}</span>}
				<span className="agent-tool-elapsed">{call.status === "running" ? "running…" : call.status === "cancelled" ? (call.result?.status === "not_applied" ? "not applied" : "result unknown") : formatElapsed(call.elapsedMs)}</span>
				<FiChevronRight size={12} aria-hidden="true" />
			</summary>
			<pre className="agent-tool-detail">{detail}</pre>
		</details>
		{call.failure && <div className="agent-error" role="alert">
			<span>{call.failure.message || ERROR_COPY[call.failure.code] || "The turn failed."}</span>
			<div className="agent-error-actions">
				<button type="button" className="agent-ghost-button agent-error-retry" onClick={onRetry}>Retry</button>
				<button type="button" className="agent-ghost-button agent-error-details" onClick={(event) => { const card = event.currentTarget.closest(".agent-tool-card"); const details = card?.querySelector("details"); if (details) details.open = !details.open; }}>Details</button>
			</div>
		</div>}
	</div>;
}

function ImageResultCard({ image, onUse, onUndo, onRegenerate, onOpen }) {
	const applying = image.apply?.status === "applying";
	const failed = image.apply?.status === "failed";
	return <div className="agent-card agent-image-card" data-image-id={image.imageId} data-placed={image.placed ? "true" : "false"} data-apply-status={image.apply?.status || "idle"}>
		<figure>
			<img src={image.dataUrl} width={image.width} height={image.height} alt={image.prompt || "Generated image"} onClick={() => onOpen(image)} />
		</figure>
		{image.placed
			? <div className="agent-placed"><StatusDot tone="ok" />Placed<button type="button" className="agent-image-undo" disabled={applying} onClick={() => onUndo(image)}>{applying ? "Removing…" : "Undo"}</button></div>
			: <div className="agent-image-actions">
				<button type="button" className="primary agent-image-use" disabled={applying} onClick={() => onUse(image)}><FiImage size={11} /> {applying ? "Applying…" : "Use in scene"}</button>
				<a className="agent-image-download" role="button" href={image.dataUrl} download={`${image.imageId || "agent-image"}.png`}><FiDownload size={11} /> Download</a>
				<button type="button" className="agent-image-regenerate" onClick={() => onRegenerate(image)}><FiRotateCw size={11} /> Regenerate</button>
			</div>}
		{/* The card states what the editor actually did: an unacknowledged or
		    refused action is never drawn as a placement. */}
		{failed && <p className="agent-image-error" role="alert">{image.apply.error}</p>}
	</div>;
}

function PausedCard({ resetAt, onRetry, onSwitchModel }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const countdown = formatResetIn(resetAt, now);
	return <div className="agent-paused" data-agent-card="rate-limited" role="status">
		<div className="agent-paused-head"><FiClock size={12} aria-hidden="true" /> Paused — usage limit reached
			<span className="agent-paused-countdown">{countdown ? `resets in ${countdown}` : "resets soon"}</span>
		</div>
		<p style={{ margin: 0 }}>{ERROR_COPY.rate_limit}</p>
		<div className="agent-paused-actions">
			<button type="button" className="agent-paused-wait" onClick={onRetry}>Wait &amp; retry</button>
			<button type="button" className="agent-paused-switch" onClick={onSwitchModel}>Switch model</button>
		</div>
	</div>;
}

// A generation is a server-owned job. The card shows the state the runtime
// reported, the phase it named and only a progress value it actually sent.
function JobCard({ job, onStop, onAccept }) {
	const running = !isTerminalJobState(job.state);
	// A finished job never keeps showing the percentage or the phase it was in
	// when it finished; the terminal state and its receipt are the truth.
	const percent = running && Number.isFinite(job.progress) ? Math.round(job.progress * 100) : null;
	const phase = job.state === "installed" ? null : job.phase;
	const unverified = job.state === "review_required" || job.verification?.status === "unverified";
	const limitations = job.verification?.limitations ?? [];
	return <div className="agent-card agent-job-card" data-job-id={job.jobId} data-job-state={job.state}>
		<div className="agent-job-head">
			<StatusDot tone={jobStateTone(job.state)} title={job.state} />
			<span className="agent-job-label">{JOB_STATE_COPY[job.state] || job.state}</span>
			{unverified && <span className="agent-job-badge">Unverified</span>}
			{percent !== null && <span className="agent-job-progress">{formatJobProgress(job.progress)}</span>}
		</div>
		{phase && <p className="agent-job-phase">{phase}</p>}
		{/* An acknowledged Stop states what happened to the scene; the state label
		    alone does not. Uncertainty is reported as uncertainty, never as safety. */}
		{job.outcome?.status === "not_applied" && <p className="agent-job-outcome">Not applied — scene unchanged.</p>}
		{job.outcome?.status === "unknown" && <p className="agent-job-outcome">Stopped, but the result is unknown — reconcile before editing this target.</p>}
		{percent !== null && <div className="agent-job-bar" role="progressbar" aria-label="Generation progress" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
			<span className="agent-job-bar-fill" style={{ transform: `scaleX(${job.progress})` }} />
		</div>}
		{limitations.length > 0 && <ul className="agent-job-limits">{limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul>}
		<div className="agent-job-actions">
			{running && job.state !== "review_required" && <button type="button" className="agent-ghost-button agent-job-stop" onClick={() => onStop(job)}>Stop</button>}
			{job.acceptance?.status === "required" && <button type="button" className="agent-ghost-button agent-job-accept" onClick={() => onAccept(job)}><FiAlertTriangle size={11} /> Apply with warnings</button>}
			{job.acceptance?.status === "accepting" && <span className="agent-job-note">Applying…</span>}
			{job.acceptance?.status === "accepted" && <span className="agent-job-note"><FiCheck size={11} /> Applied at your request</span>}
			{job.acceptance?.error && <span className="agent-job-note alert" role="alert">{job.acceptance.error}</span>}
		</div>
	</div>;
}

function ReceiptCard({ item }) {
	const { receipt = {}, summary } = item;
	const unverified = receipt.verification?.status === "unverified";
	const limitations = receipt.verification?.limitations ?? [];
	const warnings = receipt.warnings ?? [];
	return <div className="agent-card agent-receipt-card" data-receipt-id={item.receiptId} data-receipt-status={receipt.status}>
		<div className="agent-receipt-head">
			<StatusDot tone={unverified ? "warn" : "ok"} title={receipt.status} />
			<span className="agent-receipt-summary">{summary}</span>
		</div>
		{(warnings.length > 0 || limitations.length > 0) && <ul className="agent-receipt-notes">
			{warnings.map((warning) => <li key={warning.code}>{warning.message || warning.code}</li>)}
			{limitations.map((limit) => <li key={limit}>{limit}</li>)}
		</ul>}
	</div>;
}

const RECOVERY_COPY = {
	none: "No recovery is available for this command.",
	inspect: "Ask the agent to inspect the target before trying again.",
	retry: "The same command can be retried.",
	new_intent: "Tell the agent what to do with the changed target.",
	reconcile: "The result is unknown; reconcile before changing this target.",
	sign_in: "Sign in again to continue.",
};

function FailureCard({ failure, onRetry }) {
	return <div className="agent-card agent-failure-card" data-failure-code={failure.code} role="alert">
		<div className="agent-failure-head"><FiAlertTriangle size={12} aria-hidden="true" /><span className="agent-failure-code">{failure.code}</span></div>
		<p className="agent-failure-message">{failure.message || "The command did not complete."}</p>
		<p className="agent-failure-recovery">{RECOVERY_COPY[failure.recovery?.action] || RECOVERY_COPY.none}{failure.preserved?.authoredState === "unchanged" ? " Nothing in the scene changed." : failure.preserved?.authoredState === "unknown" ? " Whether the scene changed is unknown." : ""}</p>
		{failure.recovery?.retryAllowed && <div className="agent-error-actions"><button type="button" className="agent-ghost-button agent-error-retry" onClick={onRetry}>Retry</button></div>}
	</div>;
}

// One provider's credential row. The key lives in this component and nowhere
// else: it is typed into a password field, handed to the transport once and
// dropped the moment the sidecar accepts it, so no store, no transcript and no
// screenshot can ever carry it. The sidecar answers with the SOURCE of a key
// (env / file), never with a key, which is what the row reports.
function ProviderKeyRow({ provider, onSave, onRemove }) {
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const fromEnv = provider.authSource === "env";
	const fromFile = provider.authSource === "file";
	const envLabel = `set by ${providerEnvLabel(provider.id)}`;
	const inputId = `agent-key-${provider.id}`;
	const run = async (action) => {
		setBusy(true);
		setError("");
		try {
			await action();
			// The key is gone from the page the instant it is stored.
			setDraft("");
		} catch (failure) {
			// The sidecar's own refusal, which never quotes key material.
			setError(failure?.message || "The sidecar refused that key.");
		} finally {
			setBusy(false);
		}
	};
	return <div className="agent-key-row" data-provider={provider.id} data-provider-source={provider.authSource || "none"} data-provider-signed-in={provider.signedIn ? "true" : "false"}>
		<div className="agent-key-head">
			<StatusDot tone={provider.signedIn ? "ok" : ""} title={provider.signedIn ? "key configured" : "no key"} />
			<label className="agent-key-label" htmlFor={inputId}>{provider.label}</label>
			{/* The head states WHERE the key lives in two words; the variable's own
			    name belongs on the input it replaces, where there is room for it. */}
			<span className="agent-key-source">{fromEnv ? "environment" : fromFile ? "saved on this machine" : "no key"}</span>
		</div>
		<div className="agent-key-controls">
			<input
				id={inputId}
				className="agent-key-input"
				type="password"
				autoComplete="off"
				spellCheck="false"
				aria-label={`${provider.label} API key`}
				placeholder={fromEnv ? envLabel : provider.signedIn ? "Replace key" : "Paste API key"}
				disabled={fromEnv || busy}
				value={draft}
				onChange={(event) => { setDraft(event.target.value); setError(""); }}
			/>
			<button type="button" className="agent-key-save" disabled={fromEnv || busy || !draft.trim()} onClick={() => run(() => onSave(provider.id, draft))}>Save</button>
			{fromFile && <button type="button" className="agent-ghost-button agent-key-remove" disabled={busy} onClick={() => run(() => onRemove(provider.id))}>Remove</button>}
		</div>
		{error && <p className="agent-key-error" role="alert">{error}</p>}
	</div>;
}

// `defaultCollapsed` + `onCollapsedChange` let a host mirror the panel's
// visibility in its own chrome (the studio's View ▾ menu) without taking the
// flag away from the panel: the rail button, Cmd/Ctrl+B and the toggle event
// all still flip it here, and the host is told after every flip.
//
// `embedded` is the other arrangement: a host (the Studio Inspector column)
// owns the width, the visibility and the global shortcut, and passes `hidden`.
// The panel then stays mounted with its draft, session and transcript intact,
// renders no rail, no resize handle and no collapse control, and never binds a
// window shortcut that would fire twice.
export default function AgentPanel({
	transport: injectedTransport = null,
	sceneName = "CozyClay Scene",
	defaultCollapsed = false,
	onCollapsedChange = null,
	embedded = false,
	hidden = false,
	surface = "workflow",
	buildContext = null,
	onImageAction = null,
	onReceipt = null,
}) {
	// What this host shows around the shared conversation: labels, chips, the
	// affordances it owns and the ones it has no use for.
	const presentation = useMemo(() => panelPresentation(surface), [surface]);
	// The surface is a prop, not an inference from the address bar: an embedded
	// Studio panel is a Studio panel on every route.
	const transport = useMemo(() => injectedTransport || createAgentTransport({ surface }), [injectedTransport, surface]);
	const mockState = transport.mock ? transport.state : null;

	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	// Only the dock owns a width; an embedded host sizes the panel itself and
	// never reads the dock's stored key.
	const [width, setWidth] = useState(() => presentation.persistWidth ? readStoredPanelWidth() : AGENT_PANEL_WIDTH_DEFAULT);
	const [resizing, setResizing] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [account, setAccount] = useState(null);
	const [authState, setAuthState] = useState("loading");
	// No model is assumed. Sending a guessed id is how a turn fails upstream with
	// nothing the panel can explain, so the composer waits for /agent/models.
	const [models, setModels] = useState([]);
	// The same list grouped by the provider that serves it, which is the only
	// way five providers' models fit one dropdown legibly.
	const [modelProviders, setModelProviders] = useState([]);
	const [model, setModel] = useState("");
	const [modelsState, setModelsState] = useState("loading");
	// null = the model's backend default; picking a model resets it.
	const [effort, setEffort] = useState(null);
	const efforts = useMemo(() => effortOptions(models.find((entry) => entry.id === model)), [models, model]);
	// Picking a model is a preference, not a per-session decision: the key is
	// remembered so a reload does not quietly move the next turn to another
	// provider's model.
	const chooseModel = useCallback((id) => { setModel(id); setEffort(null); storeModel(id); }, []);
	// One place takes `{ providers, models }` from the sidecar: the grouped list
	// the dropdown draws, the flat key-addressed list every lookup uses, and the
	// model to open with. Returns false when nothing was advertised.
	const applyModelList = useCallback((advertised) => {
		const list = Array.isArray(advertised?.models) ? advertised.models : [];
		if (!list.length) return false;
		const providers = Array.isArray(advertised?.providers) ? advertised.providers : [];
		setModelProviders(providers);
		setModels(list);
		// A saved or removed key arrives through this same path, so a selection the
		// panel opened with is dropped here the moment its provider cannot run it.
		setModel((current) => nextSelectedModel(providers, list, current));
		setModelsState("ready");
		return true;
	}, []);
	const [attachFrame, setAttachFrame] = useState(false);
	// What the composer refused and why, in one line under the thumbnails: a
	// picture that silently fails to attach is the bug this replaces.
	const [attachNotice, setAttachNotice] = useState(null);
	const [dropping, setDropping] = useState(false);
	const [lightbox, setLightbox] = useState(null);
	const [overlay, setOverlay] = useState(() => !embedded && (globalThis.innerWidth || 1440) < AGENT_PANEL_OVERLAY_BREAKPOINT);
	const [historyOpen, setHistoryOpen] = useState(false);
	// Provider credentials, read from the sidecar only while the section is open.
	const [keysOpen, setKeysOpen] = useState(false);
	const [providers, setProviders] = useState([]);
	const [providersState, setProvidersState] = useState("loading");
	const [historySessions, setHistorySessions] = useState([]);
	const [restoreNotice, setRestoreNotice] = useState("");
	// Why the last steer did not reach the running turn. It reads in the same
	// line the restore notice uses, because it is the same kind of statement:
	// something the panel tried and could not do.
	const [steerNotice, setSteerNotice] = useState("");
	const [restoreReady, setRestoreReady] = useState(surface !== "studio");

	const composerRef = useRef(null);
	const transcriptRef = useRef(null);

	// The host's context builder and image-action handler are read through refs
	// so a re-rendered host never rebuilds the conversation.
	const buildContextRef = useRef(buildContext);
	buildContextRef.current = buildContext;
	const imageActionRef = useRef(onImageAction);
	imageActionRef.current = onImageAction;
	const receiptRef = useRef(onReceipt);
	receiptRef.current = onReceipt;

	const store = useMemo(() => createAgentChatStore({
		transport,
		surface,
		buildContext: () => buildContextRef.current?.() ?? null,
		// Host prop first, then the scripted mock host, then the live editor event.
		requestImageAction: (request) => (imageActionRef.current ?? transport.applyImage?.bind(transport) ?? requestHostImageAction)(request),
		onReceipt: (receipt) => receiptRef.current?.(receipt),
		onAuthLost: () => setAuthState("signed-out"),
	}), [surface, transport]);
	const chat = useSyncExternalStore(store.subscribe, store.getState, store.getState);
	const { draft, items, pendingAttachments, quota, rateLimit, streaming } = chat;

	// Studio history is sidecar-backed; Workflow keeps the existing in-memory UX.
	useEffect(() => {
		if (surface !== "studio") { setRestoreReady(true); return undefined; }
		let cancelled = false;
		let stored = null;
		try { stored = globalThis.localStorage?.getItem(STUDIO_SESSION_STORAGE_KEY); } catch { /* storage may be unavailable */ }
		if (!stored) { setRestoreReady(true); return undefined; }
		(async () => {
			try {
				const payload = await transport.loadSession(stored);
				if (!Array.isArray(payload?.transcript)) throw new Error("missing transcript");
				if (!cancelled) store.restore(payload.transcript, payload.sessionId || stored);
			} catch {
				if (!cancelled) {
					store.newSession();
					setRestoreNotice("Previous conversation could not be restored");
				}
			} finally {
				if (!cancelled) setRestoreReady(true);
			}
		})();
		return () => { cancelled = true; };
	}, [surface, store, transport]);

	useEffect(() => {
		if (surface !== "studio" || !restoreReady) return;
		try { globalThis.localStorage?.setItem(STUDIO_SESSION_STORAGE_KEY, chat.sessionId); } catch { /* storage may be unavailable */ }
	}, [chat.sessionId, restoreReady, surface]);

	// --- activity line -----------------------------------------------------
	// One line that always states what the panel is doing, ticking while a turn
	// is live and holding the turn's outcome for a few seconds after it ends.
	const [activityNow, setActivityNow] = useState(() => Date.now());
	const activity = model
		? describeActivity(chat, { now: activityNow, toolLabel: (call) => resolveToolLabel(call, presentation.toolLabels) })
		: modelsState === "failed"
			? { phase: "no-model", kind: "terminal", tone: "alert", text: "No model available — the agent service did not answer with one", ticking: false }
			: { phase: "models", kind: "live", tone: "busy", text: "Loading models…", ticking: false };
	useEffect(() => {
		if (!activity.ticking) return;
		const timer = setInterval(() => setActivityNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [activity.ticking]);

	// --- session bootstrap -------------------------------------------------
	// Two ways in (#379): the ChatGPT sign-in, or a provider key the sidecar
	// already holds. `providersConfigured` counts the second, so a session that
	// never signed in to ChatGPT still gets a composer instead of a sign-in wall
	// it does not need.
	// The image entitlement only gates a surface that can ask for an image; a
	// Studio turn authors the scene, so a plan without image generation is a
	// perfectly ready session there.
	const sessionState = useCallback((status) => status?.signedIn || status?.providersConfigured > 0
		? (presentation.imageEntitlement && status?.entitlements?.image === false ? "no-entitlement" : "ready")
		: status?.pending ? "signing-in" : "signed-out", [presentation]);
	const readAccount = useCallback(async () => {
		try {
			const status = await transport.status();
			setAccount(status);
			setAuthState(sessionState(status));
			return status;
		} catch {
			setAuthState("signed-out");
			return null;
		}
	}, [sessionState, transport]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const status = await transport.status();
				if (cancelled) return;
				setAccount(status);
				setAuthState(sessionState(status));
			} catch {
				if (!cancelled) setAuthState("signed-out");
			}
			try {
				const advertised = await transport.models();
				if (cancelled) return;
				if (!applyModelList(advertised)) { setModelsState("failed"); return; }
			} catch {
				// An unanswered model list is a visible state, not a silent guess.
				if (!cancelled) setModelsState("failed");
			}
		})();
		return () => { cancelled = true; };
	}, [applyModelList, sessionState, transport]);

	// Sign-in finishes in another window. The panel picks the session up when
	// this document is looked at again, or when the host announces the return —
	// never on a fixed timer.
	useEffect(() => {
		if (authState !== "signing-in") return;
		const onReturn = () => { if (document.visibilityState !== "hidden") readAccount(); };
		window.addEventListener("focus", onReturn);
		window.addEventListener("cozyclay:agent-auth-return", onReturn);
		document.addEventListener("visibilitychange", onReturn);
		return () => {
			window.removeEventListener("focus", onReturn);
			window.removeEventListener("cozyclay:agent-auth-return", onReturn);
			document.removeEventListener("visibilitychange", onReturn);
		};
	}, [authState, readAccount]);

	// Mock states that only exist as a rendered result (a finished streaming
	// turn, a paused card, a failed tool call) are driven by replaying the
	// scripted turn once, so QA screenshots the same code path a live turn uses.
	useEffect(() => {
		if (!mockState || authState !== "ready" || !model) return;
		if (!["streaming", "rate-limited", "error"].includes(mockState)) return;
		if (items.length) return;
		store.send("Give me a wide two-shot of this scene", { attachFrame: false, model });
	}, [authState, items.length, mockState, model, store]);

	// --- layout ------------------------------------------------------------
	useEffect(() => {
		if (embedded) return;
		const onResize = () => setOverlay((globalThis.innerWidth || 1440) < AGENT_PANEL_OVERLAY_BREAKPOINT);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [embedded]);

	useEffect(() => {
		// An embedded host owns the shortcut; binding it here too would toggle
		// the panel twice per press.
		if (embedded) return;
		const onKey = (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
				event.preventDefault();
				setCollapsed((value) => !value);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [embedded]);

	useEffect(() => {
		if (embedded) return;
		const onToggle = () => setCollapsed((value) => !value);
		window.addEventListener("cozyclay:agent-panel-toggle", onToggle);
		return () => window.removeEventListener("cozyclay:agent-panel-toggle", onToggle);
	}, [embedded]);

	useEffect(() => {
		if (embedded) return;
		onCollapsedChange?.(collapsed);
	}, [collapsed, embedded, onCollapsedChange]);

	// Focus moves to the composer whenever the panel opens. The composer only
	// mounts once the session resolves, so authState is a dependency too:
	// otherwise this fires against a composer that does not exist yet. A hidden
	// embedded panel never pulls focus out of the host's own surface.
	useEffect(() => {
		if (hidden) {
			// Chrome blurs a hidden focused field only on its next lifecycle step;
			// until then the caret is still inside chrome the author cannot see.
			if (composerRef.current && composerRef.current === document.activeElement) composerRef.current.blur();
			return;
		}
		if (!collapsed) composerRef.current?.focus();
	}, [authState, collapsed, hidden]);

	useEffect(() => {
		const node = transcriptRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [items, streaming]);

	const startResize = useCallback((event) => {
		event.preventDefault();
		setResizing(true);
		const startX = event.clientX;
		const startWidth = width;
		const onMove = (move) => setWidth(clampPanelWidth(startWidth + (startX - move.clientX)));
		const onUp = (up) => {
			setResizing(false);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			storePanelWidth(clampPanelWidth(startWidth + (startX - up.clientX)));
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [width]);

	const nudgeWidth = useCallback((delta) => {
		setWidth((current) => {
			const next = clampPanelWidth(current + delta);
			storePanelWidth(next);
			return next;
		});
	}, []);

	// --- pasted and dropped pictures ---------------------------------------
	// A screenshot is the fastest thing an author can show the agent, so the
	// composer takes one from the clipboard or the desktop. Only a transfer that
	// actually carries a picture is intercepted: a text paste still lands in the
	// caret, which is the whole reason the studio's document handler steps aside
	// for a textarea in the first place.
	const attachFiles = useCallback(async (files) => {
		const prepared = [];
		let failed = 0;
		for (const file of files) {
			try { prepared.push(await attachmentFromFile(file)); } catch { failed += 1; }
		}
		const rejected = prepared.length ? store.addAttachments(prepared).rejected : 0;
		setAttachNotice(rejected ? ATTACHMENT_LIMIT_NOTICE : failed ? ATTACHMENT_FAILED_NOTICE : null);
	}, [store]);
	/** Whether this transfer belongs to the composer. */
	const takeTransfer = useCallback((transfer) => {
		const { images, unsupported } = attachmentFilesFromTransfer(transfer);
		if (!images.length) {
			// A picture in a format the turn cannot carry is refused out loud; a
			// clipboard with no picture at all is simply not ours.
			if (unsupported) setAttachNotice(ATTACHMENT_TYPE_NOTICE);
			return unsupported > 0;
		}
		attachFiles(images);
		return true;
	}, [attachFiles]);
	const onComposerPaste = useCallback((event) => {
		if (takeTransfer(event.clipboardData)) event.preventDefault();
	}, [takeTransfer]);
	const onComposerDragOver = useCallback((event) => {
		// `files` is withheld until the drop, so the types list is the only thing
		// that can decide whether the composer wants this drag.
		if (!transferCarriesFiles(event.dataTransfer)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		setDropping(true);
	}, []);
	const onComposerDragLeave = useCallback((event) => {
		if (!event.currentTarget.contains(event.relatedTarget)) setDropping(false);
	}, []);
	const onComposerDrop = useCallback((event) => {
		setDropping(false);
		if (takeTransfer(event.dataTransfer)) event.preventDefault();
	}, [takeTransfer]);

	// --- turn --------------------------------------------------------------
	const runTurn = useCallback((text) => {
		setAttachNotice(null);
		setSteerNotice("");
		return store.send(text, { attachFrame, model, effort: effort ?? undefined });
	}, [attachFrame, effort, model, store]);
	const stopTurn = useCallback(() => store.stop(), [store]);
	// Steering the turn that is already running: the composer's text joins THAT
	// turn instead of starting a second one. A refusal (the turn ended while the
	// stream was still open, or this surface cannot be steered) says so and
	// leaves the draft to be sent as a normal message.
	const steerTurn = useCallback(async (text) => {
		if (!String(text ?? "").trim()) return;
		setAttachNotice(null);
		setSteerNotice("");
		const result = await store.steer(text);
		if (!result.ok) setSteerNotice(result.message || "The running turn did not take that message.");
	}, [store]);

	const signIn = useCallback(async () => {
		setAuthState("signing-in");
		try {
			await transport.signIn();
			await readAccount();
		} catch {
			setAuthState("signed-out");
		}
	}, [readAccount, transport]);

	const signOut = useCallback(async () => {
		setMenuOpen(false);
		await transport.signOut().catch(() => {});
		setAccount(null);
		setAuthState("signed-out");
		store.newSession();
	}, [store, transport]);

	const newSession = useCallback(() => {
		if (surface === "studio") {
			try { globalThis.localStorage?.removeItem(STUDIO_SESSION_STORAGE_KEY); } catch { /* storage may be unavailable */ }
		}
		store.newSession();
		setHistoryOpen(false);
		setMenuOpen(false);
		composerRef.current?.focus();
	}, [store, surface]);

	const openHistory = useCallback(async () => {
		if (surface !== "studio") return;
		const nextOpen = !historyOpen;
		setHistoryOpen(nextOpen);
		if (!nextOpen) return;
		try { setHistorySessions(await transport.listSessions()); } catch { setHistorySessions([]); }
	}, [historyOpen, surface, transport]);
	const restoreHistorySession = useCallback(async (sessionId) => {
		try {
			const payload = await transport.loadSession(sessionId);
			if (!Array.isArray(payload?.transcript)) throw new Error("missing transcript");
			store.restore(payload.transcript, payload.sessionId || sessionId);
			setHistoryOpen(false);
			setRestoreNotice("");
		} catch {
			setRestoreNotice("Previous conversation could not be restored");
		}
	}, [store, transport]);

	// --- provider keys -----------------------------------------------------
	// The sidecar owns the credentials; this section only states which providers
	// have one and where it came from. The list is read when the section opens
	// and again after every write — a key that just landed (or left) changes
	// which models the composer may offer, so the model list is re-read with it.
	const readProviders = useCallback(async () => {
		try {
			const list = await transport.providers?.();
			if (!Array.isArray(list)) throw new Error("no provider list");
			setProviders(list);
			setProvidersState("ready");
		} catch {
			setProviders([]);
			setProvidersState("failed");
		}
	}, [transport]);
	// A credential write also changes WHO the session is: readiness is
	// `signedIn || providersConfigured > 0`, so the account that gate reads is
	// re-requested through the same status call, once per write, beside the rows
	// and the models. That is what lets a signed-out author who just saved their
	// first key type into a composer without reloading the page — and what takes
	// it away again when the last key is removed. No timer is involved.
	const refreshProviderState = useCallback(async () => {
		const session = readAccount();
		await readProviders();
		await session;
		try {
			applyModelList(await transport.models());
		} catch { /* the composer keeps the list it was last advertised */ }
	}, [applyModelList, readAccount, readProviders, transport]);
	const toggleProviderKeys = useCallback(() => {
		setMenuOpen(false);
		const next = !keysOpen;
		setKeysOpen(next);
		if (!next) return;
		setProvidersState("loading");
		readProviders();
	}, [keysOpen, readProviders]);
	const saveProviderKey = useCallback(async (id, key) => {
		await transport.setProviderKey(id, key);
		await refreshProviderState();
	}, [refreshProviderState, transport]);
	const removeProviderKey = useCallback(async (id) => {
		await transport.removeProviderKey(id);
		await refreshProviderState();
	}, [refreshProviderState, transport]);

	// Clearing the transcript also retires the session, so what the author sees
	// and what the model remembers cannot diverge.
	const clearContext = useCallback(() => {
		store.clearContext();
		setMenuOpen(false);
	}, [store]);

	const switchModel = useCallback(() => {
		// Only a model whose provider holds a credential is worth switching to:
		// the others are exactly the ones the dropdown draws disabled.
		const usable = models.filter((entry) => modelIsSelectable(modelProviders, entry.id));
		const list = usable.length ? usable : models;
		const index = list.findIndex((entry) => entry.id === model);
		const next = list[(index + 1) % list.length];
		if (next) chooseModel(next.id);
		store.clearRateLimit();
	}, [chooseModel, model, modelProviders, models, store]);

	const onComposerKeyDown = useCallback((event) => {
		if (event.key === "Escape" && streaming) {
			event.preventDefault();
			stopTurn();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			// Enter does what the button under it says: Send, or Steer while a turn
			// on a steerable surface is still running.
			if (streaming) { if (presentation.steer) steerTurn(draft); return; }
			runTurn(draft);
		}
	}, [draft, presentation, runTurn, steerTurn, stopTurn, streaming]);

	const panelState = rateLimit ? "rate-limited"
		: authState !== "ready" ? authState
		: streaming ? "streaming"
		: items.some((item) => (item.kind === "tool" && item.status === "failed") || item.kind === "failure") ? "error"
		: "ready";
	const statusTone = { "signed-out": "", "signing-in": "busy", "no-entitlement": "warn", ready: "ok", streaming: "busy", "rate-limited": "warn", error: "alert" }[panelState] || "";
	const resetLabel = formatResetIn(rateLimit?.resetAt || quota?.resetAt);
	// A disabled composer under the sign-in card is dead weight: the composer
	// only exists once there is a session to talk to.
	const authenticated = authState === "ready" || authState === "no-entitlement";
	// A model whose provider holds no credential is not something this session
	// can send to: the composer stays shut instead of submitting a turn the
	// provider would refuse.
	const composerDisabled = panelState === "rate-limited" || !model || !modelIsSelectable(modelProviders, model);

	if (collapsed && !embedded) {
		return <aside className="agent-panel collapsed" data-agent-state={panelState} data-agent-collapsed="true" aria-label="Agent panel, collapsed">
			<button type="button" className="agent-rail-toggle" onClick={() => setCollapsed(false)} aria-label="Expand agent panel" title="Expand agent panel (Cmd/Ctrl+B)"><FiChevronRight size={13} style={{ transform: "rotate(180deg)" }} /></button>
			<StatusDot tone={statusTone} title={panelState} />
			<span className="agent-rail-label">Agent</span>
		</aside>;
	}

	return <aside
		className={`agent-panel${resizing ? " resizing" : ""}${overlay && !embedded ? " overlay" : ""}${embedded ? " embedded" : ""}`}
		style={embedded ? undefined : { width: `${width}px` }}
		hidden={embedded && hidden}
		data-agent-state={panelState}
		data-agent-width={embedded ? undefined : width}
		data-agent-overlay={overlay && !embedded ? "true" : "false"}
		data-agent-embedded={embedded ? "true" : "false"}
		aria-label="Agent"
	>
		{!embedded && <div
			role="separator"
			aria-label="Resize agent panel"
			aria-orientation="vertical"
			aria-valuenow={width}
			aria-valuemin={AGENT_PANEL_WIDTH_MIN}
			aria-valuemax={AGENT_PANEL_WIDTH_MAX}
			tabIndex={0}
			className="agent-resize"
			onPointerDown={startResize}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") { event.preventDefault(); nudgeWidth(16); }
				if (event.key === "ArrowRight") { event.preventDefault(); nudgeWidth(-16); }
			}}
		/>}

		<header className="agent-header">
			<StatusDot tone={statusTone} title={panelState} />
			<h2 className="agent-title">Agent</h2>
			<span className="agent-header-spacer" />
			<button type="button" className="agent-ghost-button agent-new" onClick={newSession}><FiPlus size={11} /> New</button>
			{presentation.history && <span className="agent-history-wrap">
				<button type="button" className="agent-ghost-button agent-history" aria-haspopup="listbox" aria-expanded={surface === "studio" ? historyOpen : undefined} onClick={surface === "studio" ? openHistory : undefined} disabled={surface !== "studio"}>History</button>
				{surface === "studio" && historyOpen && <div className="agent-history-popover" role="listbox" aria-label="Agent history">
					{historySessions.length ? historySessions.map((entry) => <button type="button" role="option" className="agent-history-item" key={entry.sessionId} onClick={() => restoreHistorySession(entry.sessionId)}>
						<span className="agent-history-time">{relativeTime(entry.updatedAt)}</span>
						<span className="agent-history-text">{entry.firstText || "Untitled conversation"}</span>
					</button>) : <span className="agent-history-empty">No previous conversations</span>}
				</div>}
			</span>}
			<span className="agent-overflow">
				<button type="button" className="agent-icon-button agent-overflow-toggle" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="More agent actions" onClick={() => setMenuOpen((value) => !value)}><FiMoreHorizontal size={13} /></button>
				{menuOpen && <div className="agent-menu" role="menu">
					<button type="button" role="menuitem" onClick={clearContext}>Clear context</button>
					<button type="button" role="menuitem" className="agent-menu-keys" aria-expanded={keysOpen} onClick={toggleProviderKeys}>Provider keys…</button>
					<button type="button" role="menuitem" onClick={signOut}>Sign out</button>
				</div>}
			</span>
			{!embedded && <button type="button" className="agent-icon-button agent-collapse" onClick={() => setCollapsed(true)} aria-label="Collapse agent panel" title="Collapse agent panel (Cmd/Ctrl+B)"><FiChevronRight size={13} /></button>}
		</header>

		{restoreNotice && <div className="agent-toast" role="status">{restoreNotice}</div>}
		{steerNotice && <div className="agent-toast alert agent-steer-notice" role="alert">{steerNotice}</div>}

		{account?.signedIn && <div className="agent-account">
			<span className="agent-account-email">{account.email}</span>
			<span className="agent-plan-badge">{quota?.plan || account.plan || "Free"}</span>
			{resetLabel && <span className="agent-account-reset">resets in {resetLabel}</span>}
		</div>}

		{/* An inline section, not a modal: the panel stays the one place the
		    conversation and the credentials it runs on are managed. */}
		{keysOpen && <section className="agent-keys" aria-label="Provider keys" data-agent-keys="true">
			<div className="agent-keys-head">
				<h3 className="agent-keys-title">Provider keys</h3>
				<button type="button" className="agent-icon-button agent-keys-close" aria-label="Close provider keys" onClick={() => setKeysOpen(false)}><FiX size={11} aria-hidden="true" /></button>
			</div>
			<p className="agent-keys-hint">Keys are stored by the local CozyClay service and are never shown again.</p>
			{providersState === "loading" && <p className="agent-keys-note">Loading providers…</p>}
			{providersState === "failed" && <p className="agent-keys-note alert" role="alert">The provider list is unavailable.</p>}
			{providers.filter((entry) => entry.id !== "openai-codex").map((entry) => <ProviderKeyRow key={entry.id} provider={entry} onSave={saveProviderKey} onRemove={removeProviderKey} />)}
		</section>}

		<div className="agent-transcript" ref={transcriptRef} aria-live="polite" aria-label="Conversation" data-agent-transcript="true">
			{authState === "signed-out" && <div className="agent-state-card" data-agent-card="signed-out">
				<h3>Sign in with ChatGPT</h3>
				<p>The agent runs against your ChatGPT plan. Sign-in happens in your browser — no token is ever stored in this page.</p>
				<button type="button" className="agent-primary-button agent-signin" onClick={signIn}>Sign in with ChatGPT</button>
			</div>}

			{authState === "signing-in" && <div className="agent-state-card" data-agent-card="signing-in">
				<span className="agent-spinner" aria-hidden="true" />
				<h3>Waiting for your browser…</h3>
				<p>Finish the ChatGPT sign-in in the tab that just opened. This panel picks up the session when you come back.</p>
			</div>}

			{authState === "no-entitlement" && <div className="agent-state-card" data-agent-card="no-entitlement">
				<h3>Image generation is not on this plan</h3>
				<p>Signed in as {account?.email || "your account"}. Chat and tool calls work; image results need a plan with image generation.</p>
				<button type="button" className="agent-primary-button" onClick={() => window.open("https://chatgpt.com/#pricing", "_blank", "noopener,noreferrer")}>See plans</button>
			</div>}

			{authState === "ready" && !items.length && !rateLimit && <div className="agent-state-card" data-agent-card="ready">
				<h3>{presentation.emptyTitle}</h3>
				<p>{presentation.emptyHint(sceneName)}</p>
				<div className="agent-suggestions">
					{presentation.suggestions.map((chip) => <button type="button" key={chip} className="agent-chip" onClick={() => { store.setDraft(chip); composerRef.current?.focus(); }}>{chip}</button>)}
				</div>
			</div>}

			{items.map((item) => {
				if (item.kind === "user") return <div className="agent-row user" key={item.id}>
					{item.attachments?.length > 0 && <div className="agent-bubble-attachments">
						{item.attachments.map((attachment, index) => <img key={`${item.id}-${index}`} src={attachment.dataUrl} alt={attachment.name || "Attached image"} onClick={() => setLightbox({ dataUrl: attachment.dataUrl, prompt: attachment.name })} />)}
					</div>}
					<div className="agent-bubble">{item.text}</div>
				</div>;
				if (item.kind === "assistant") return <div className="agent-row assistant" key={item.id}><div className="agent-assistant-text">{item.text}{streaming && <span className="agent-caret">▌</span>}</div></div>;
				if (item.kind === "tool") return <div className="agent-row" key={item.id}><ToolCallCard call={item} presentation={presentation} onRetry={() => runTurn(chat.lastPrompt)} /></div>;
				if (item.kind === "job") return <div className="agent-row" key={item.id}><JobCard job={item} onStop={stopTurn} onAccept={(job) => store.acceptJob(job.jobId)} /></div>;
				if (item.kind === "receipt") return <div className="agent-row" key={item.id}><ReceiptCard item={item} /></div>;
				if (item.kind === "failure") return <div className="agent-row" key={item.id}><FailureCard failure={item.failure} onRetry={() => runTurn(chat.lastPrompt)} /></div>;
				return <div className="agent-row" key={item.id}><ImageResultCard image={item} onUse={(image) => store.applyImage(image.id)} onUndo={(image) => store.undoImage(image.id)} onRegenerate={() => runTurn(chat.lastPrompt)} onOpen={setLightbox} /></div>;
			})}

			{rateLimit && <PausedCard resetAt={rateLimit.resetAt} onRetry={() => { store.clearRateLimit(); runTurn(chat.lastPrompt); }} onSwitchModel={switchModel} />}
		</div>

		{/* Never a blank panel: busy states name the phase and tick, a finished
		    turn states how it ended, and idle says so in as many words. */}
		{authenticated && <div className="agent-activity" data-agent-activity={activity.phase} data-agent-activity-kind={activity.kind} role="status" aria-live="polite">
			<span className={`agent-activity-indicator ${activity.tone}`} aria-hidden="true" />
			<span className="agent-activity-text">{activity.text}</span>
		</div>}

		{authenticated && <div
			className="agent-composer"
			data-agent-dropping={dropping ? "true" : "false"}
			onDragOver={composerDisabled ? undefined : onComposerDragOver}
			onDragLeave={composerDisabled ? undefined : onComposerDragLeave}
			onDrop={composerDisabled ? undefined : onComposerDrop}
		>
			{pendingAttachments.length > 0 && <ul className="agent-attachments" aria-label="Attached images">
				{pendingAttachments.map((attachment) => <li key={attachment.id} className="agent-attachment">
					<img src={attachment.dataUrl} alt={attachment.name || "Attached image"} />
					<button type="button" className="agent-attachment-remove" aria-label={`Remove ${attachment.name || "attached image"}`} onClick={() => store.removeAttachment(attachment.id)}><FiX size={10} aria-hidden="true" /></button>
				</li>)}
			</ul>}
			{attachNotice && <p className="agent-attachment-notice" role="status">{attachNotice}</p>}
			<textarea
				ref={composerRef}
				className="agent-input"
				aria-label="Message the agent"
				placeholder={panelState === "rate-limited" ? "Composer is paused" : model ? presentation.composerPlaceholder : "Waiting for the model list…"}
				value={draft}
				disabled={composerDisabled}
				onChange={(event) => store.setDraft(event.target.value)}
				onKeyDown={onComposerKeyDown}
				onPaste={onComposerPaste}
				onDragOver={onComposerDragOver}
				onDrop={onComposerDrop}
			/>
			<div className="agent-composer-controls agent-composer-picks">
				{/* Five providers in one dropdown: grouped by the provider that serves
				    them, and a provider without a credential still lists its models —
				    unpickable, and saying what they are waiting for. */}
				<select className="agent-model-select" aria-label="Model" value={model} disabled={!models.length} onChange={(event) => chooseModel(event.target.value)}>
					{modelProviders.length
						? modelProviders.map((provider) => <optgroup key={provider.id} label={provider.label}>
							{provider.models.length
								? provider.models.map((entry) => <option key={entry.key} value={entry.key} disabled={!provider.signedIn}>{provider.signedIn ? entry.label : `${entry.label} — add key`}</option>)
								: <option value={`${provider.id}/`} disabled>{provider.signedIn ? "No models" : "No models — add key"}</option>}
						</optgroup>)
						: models.length
							? models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)
							: <option value="">{modelsState === "failed" ? "No model available" : "Loading models…"}</option>}
				</select>
				{efforts.length > 0 && (
					<select className="agent-model-select agent-effort-select" aria-label="Reasoning effort" title="Reasoning effort" value={effort ?? efforts[0]} onChange={(event) => setEffort(event.target.value)}>
						{efforts.map((value, index) => <option key={value} value={value}>{index === 0 ? `${value} · default` : value}</option>)}
					</select>
				)}
			</div>
			<div className="agent-composer-controls">
				<button type="button" className="agent-attach-chip" aria-pressed={attachFrame} onClick={() => setAttachFrame((value) => !value)}>
					{attachFrame ? <span className="agent-attach-thumb" aria-hidden="true" /> : <FiPaperclip size={11} aria-hidden="true" />}
					Attach current frame
				</button>
				<span className="agent-composer-spacer" aria-hidden="true" />
				{/* While a turn runs, Stop is still the way out of it; on a surface
				    that can be steered, Send becomes the way INTO it. */}
				{streaming
					? <>
						<button type="button" className="agent-send stop agent-stop" onClick={stopTurn}>Stop</button>
						{presentation.steer && <button type="button" className="agent-send agent-steer" disabled={!draft.trim()} onClick={() => steerTurn(draft)}>Steer</button>}
					</>
					: <button type="button" className="agent-send" disabled={composerDisabled || !draft.trim()} onClick={() => runTurn(draft)}>Send</button>}
			</div>
		</div>}
		{/* The hint exists to warn about image spend; a surface that cannot
		    generate an image has nothing to warn about. */}
		{authenticated && presentation.imageHint && <p className="agent-footer-hint">{presentation.imageHint}</p>}

		{lightbox && <button type="button" className="agent-lightbox" aria-label="Close image preview" onClick={() => setLightbox(null)}>
			<img src={lightbox.dataUrl} alt={lightbox.prompt || "Generated image"} />
		</button>}
	</aside>;
}

export { AGENT_STATES, AGENT_PANEL_RAIL_WIDTH };
