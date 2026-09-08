import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiChevronRight, FiClock, FiDownload, FiImage, FiMoreHorizontal, FiPaperclip, FiPlus, FiRotateCw } from "react-icons/fi";
import {
	AGENT_PANEL_OVERLAY_BREAKPOINT,
	AGENT_PANEL_RAIL_WIDTH,
	AGENT_PANEL_WIDTH_MAX,
	AGENT_PANEL_WIDTH_MIN,
	AGENT_STATES,
	DEFAULT_MODELS,
	effortOptions,
	ERROR_COPY,
	IMAGE_COST_HINT,
	SUGGESTION_CHIPS,
	clampPanelWidth,
	createAgentTransport,
	formatElapsed,
	formatResetIn,
	readStoredPanelWidth,
	storePanelWidth,
	toolCallLabel,
} from "./agent-client.js";
import "./agent-panel.css";

let turnSeed = 0;
const nextId = (prefix) => `${prefix}-${(turnSeed += 1)}`;

function StatusDot({ tone, title }) {
	return <span className={`agent-status-dot ${tone}`} title={title} aria-hidden="true" />;
}

// Canvas tools read as actions, never as raw function names; the map takes
// precedence over the server's underscore-to-space label.
const CANVAS_TOOL_LABELS = {
	describe_workflow: "Read canvas",
	add_workflow_node: "Add node",
	update_workflow_node: "Edit node",
	remove_workflow_node: "Remove node",
	connect_workflow_nodes: "Connect nodes",
	disconnect_workflow_nodes: "Disconnect nodes",
	run_workflow: "Run workflow",
	set_workflow_node_output: "Set node output",
	focus_workflow_node: "Focus node",
	add_reference_node: "Add reference image",
};

function ToolCallCard({ call, onRetry }) {
	const tone = call.status === "running" ? "busy" : call.status === "failed" ? "alert" : "ok";
	const canvasTool = Object.hasOwn(CANVAS_TOOL_LABELS, call.name);
	const detail = call.error ? `error: ${call.error}` : JSON.stringify(call.result ?? call.args ?? {}, null, 2);
	return <div className={`agent-card agent-tool-card${call.status === "failed" ? " failed" : ""}`} data-tool-status={call.status} data-tool-name={call.name}>
		<details>
			<summary>
				<StatusDot tone={tone} title={call.status} />
				<span className="agent-tool-label">{canvasTool ? CANVAS_TOOL_LABELS[call.name] : toolCallLabel(call)}</span>{canvasTool && <span className="agent-tool-badge">Canvas</span>}
				<span className="agent-tool-elapsed">{call.status === "running" ? "running…" : formatElapsed(call.elapsedMs)}</span>
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
	return <div className="agent-card agent-image-card" data-image-id={image.imageId} data-placed={image.placed ? "true" : "false"}>
		<figure>
			<img src={image.dataUrl} width={image.width} height={image.height} alt={image.prompt || "Generated image"} onClick={() => onOpen(image)} />
		</figure>
		{image.placed
			? <div className="agent-placed"><StatusDot tone="ok" />Placed<button type="button" className="agent-image-undo" onClick={() => onUndo(image)}>Undo</button></div>
			: <div className="agent-image-actions">
				<button type="button" className="primary agent-image-use" onClick={() => onUse(image)}><FiImage size={11} /> Use in scene</button>
				<a className="agent-image-download" role="button" href={image.dataUrl} download={`${image.imageId || "agent-image"}.png`}><FiDownload size={11} /> Download</a>
				<button type="button" className="agent-image-regenerate" onClick={() => onRegenerate(image)}><FiRotateCw size={11} /> Regenerate</button>
			</div>}
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

// `defaultCollapsed` + `onCollapsedChange` let a host mirror the panel's
// visibility in its own chrome (the studio's View ▾ menu) without taking the
// flag away from the panel: the rail button, Cmd/Ctrl+B and the toggle event
// all still flip it here, and the host is told after every flip.
export default function AgentPanel({ transport: injectedTransport = null, sceneName = "CozyClay Scene", defaultCollapsed = false, onCollapsedChange = null }) {
	const transport = useMemo(() => injectedTransport || createAgentTransport(), [injectedTransport]);
	const mockState = transport.mock ? transport.state : null;

	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	const [width, setWidth] = useState(readStoredPanelWidth);
	const [resizing, setResizing] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [account, setAccount] = useState(null);
	const [authState, setAuthState] = useState("loading");
	const [models, setModels] = useState(DEFAULT_MODELS);
	const [model, setModel] = useState(DEFAULT_MODELS[0].id);
	// null = the model's backend default; picking a model resets it.
	const [effort, setEffort] = useState(null);
	const efforts = useMemo(() => effortOptions(models.find((entry) => entry.id === model)), [models, model]);
	const chooseModel = useCallback((id) => { setModel(id); setEffort(null); }, []);
	const [draft, setDraft] = useState("");
	const [attachFrame, setAttachFrame] = useState(false);
	const [items, setItems] = useState([]);
	const [streaming, setStreaming] = useState(false);
	const [quota, setQuota] = useState(null);
	const [rateLimit, setRateLimit] = useState(null);
	const [lightbox, setLightbox] = useState(null);
	const [overlay, setOverlay] = useState(() => (globalThis.innerWidth || 1440) < AGENT_PANEL_OVERLAY_BREAKPOINT);

	const composerRef = useRef(null);
	const transcriptRef = useRef(null);
	const abortRef = useRef(null);
	const lastPromptRef = useRef("");
	const sessionRef = useRef(nextId("session"));

	// --- session bootstrap -------------------------------------------------
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const status = await transport.status();
				if (cancelled) return;
				setAccount(status);
				setAuthState(status?.signedIn ? (status?.entitlements?.image === false ? "no-entitlement" : "ready") : status?.pending ? "signing-in" : "signed-out");
			} catch {
				if (!cancelled) setAuthState("signed-out");
			}
			try {
				const list = await transport.models();
				if (cancelled || !Array.isArray(list) || !list.length) return;
				setModels(list);
				setModel(list[0].id);
			} catch {
				// Model list is advisory; the default list stays usable offline.
			}
		})();
		return () => { cancelled = true; };
	}, [transport]);

	// Mock states that only exist as a rendered result (a finished streaming
	// turn, a paused card, a failed tool call) are driven by replaying the
	// scripted turn once, so QA screenshots the same code path a live turn uses.
	const runTurnRef = useRef(null);
	useEffect(() => {
		if (!mockState || authState !== "ready") return;
		if (!["streaming", "rate-limited", "error"].includes(mockState)) return;
		if (items.length) return;
		runTurnRef.current?.("Give me a wide two-shot of this scene");
	}, [authState, items.length, mockState]);

	// --- layout ------------------------------------------------------------
	useEffect(() => {
		const onResize = () => setOverlay((globalThis.innerWidth || 1440) < AGENT_PANEL_OVERLAY_BREAKPOINT);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	useEffect(() => {
		const onKey = (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
				event.preventDefault();
				setCollapsed((value) => !value);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		const onToggle = () => setCollapsed((value) => !value);
		window.addEventListener("cozyclay:agent-panel-toggle", onToggle);
		return () => window.removeEventListener("cozyclay:agent-panel-toggle", onToggle);
	}, []);

	useEffect(() => {
		onCollapsedChange?.(collapsed);
	}, [collapsed, onCollapsedChange]);

	// Focus moves to the composer whenever the panel opens. The composer only
	// mounts once the session resolves, so authState is a dependency too:
	// otherwise this fires against a composer that does not exist yet.
	useEffect(() => {
		if (!collapsed) composerRef.current?.focus();
	}, [authState, collapsed]);

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

	// --- turn --------------------------------------------------------------
	const applyEvent = useCallback((event) => {
		if (event?.type === "text.delta") {
			setItems((current) => {
				const last = current[current.length - 1];
				if (last?.kind === "assistant") return [...current.slice(0, -1), { ...last, text: last.text + event.text }];
				return [...current, { kind: "assistant", id: nextId("assistant"), text: event.text }];
			});
			return;
		}
		if (event?.type === "tool.start") {
			setItems((current) => [...current, { kind: "tool", id: event.callId || nextId("call"), callId: event.callId, name: event.name, label: event.label, args: event.args, status: "running" }]);
			return;
		}
		if (event?.type === "tool.done") {
			setItems((current) => current.map((item) => item.kind === "tool" && item.callId === event.callId
				? { ...item, status: event.ok ? "done" : "failed", elapsedMs: event.elapsedMs, result: event.result, error: event.error }
				: item));
			return;
		}
		if (event?.type === "image") {
			setItems((current) => [...current, { kind: "image", id: event.imageId || nextId("image"), imageId: event.imageId, dataUrl: event.dataUrl, width: event.width, height: event.height, prompt: event.prompt, placed: false }]);
			return;
		}
		if (event?.type === "quota") {
			setQuota({ plan: event.plan, usedPercent: event.primary?.usedPercent, windowMinutes: event.primary?.windowMinutes, resetAt: event.primary?.resetAt, credits: event.credits });
			return;
		}
		if (event?.type === "error") {
			if (event.code === "rate_limit") {
				setRateLimit({ resetAt: event.resetAt || null, message: event.message || ERROR_COPY.rate_limit });
				return;
			}
			if (event.code === "auth") {
				setAuthState("signed-out");
				return;
			}
			setItems((current) => {
				const index = [...current].reverse().findIndex((item) => item.kind === "tool" && item.status === "failed");
				if (index === -1) return [...current, { kind: "tool", id: nextId("call"), callId: nextId("call"), name: "agent_turn", label: "Run turn", status: "failed", failure: { code: event.code, message: event.message } }];
				const position = current.length - 1 - index;
				return current.map((item, at) => at === position ? { ...item, failure: { code: event.code, message: event.message } } : item);
			});
		}
	}, []);

	const runTurn = useCallback(async (text) => {
		const trimmed = String(text || "").trim();
		if (!trimmed || streaming) return;
		lastPromptRef.current = trimmed;
		setRateLimit(null);
		setItems((current) => [...current, { kind: "user", id: nextId("user"), text: trimmed, attachFrame }]);
		setDraft("");
		setStreaming(true);
		const controller = new AbortController();
		abortRef.current = controller;
		try {
			await transport.turn({ sessionId: sessionRef.current, text: trimmed, attachFrame, model, effort: effort ?? undefined }, applyEvent, controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) applyEvent({ type: "error", code: "upstream", message: String(error?.message || error) });
		} finally {
			abortRef.current = null;
			setStreaming(false);
		}
	}, [applyEvent, attachFrame, effort, model, streaming, transport]);
	runTurnRef.current = runTurn;

	const stopTurn = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		transport.stop?.(sessionRef.current);
		setStreaming(false);
	}, [transport]);

	const signIn = useCallback(async () => {
		setAuthState("signing-in");
		try {
			await transport.signIn();
			const status = await transport.status();
			setAccount(status);
			if (status?.signedIn) setAuthState(status?.entitlements?.image === false ? "no-entitlement" : "ready");
		} catch {
			setAuthState("signed-out");
		}
	}, [transport]);

	const signOut = useCallback(async () => {
		setMenuOpen(false);
		await transport.signOut().catch(() => {});
		setAccount(null);
		setAuthState("signed-out");
		setItems([]);
	}, [transport]);

	const newSession = useCallback(() => {
		sessionRef.current = nextId("session");
		setItems([]);
		setRateLimit(null);
		setMenuOpen(false);
		composerRef.current?.focus();
	}, []);

	const useInScene = useCallback((image) => {
		// Mock mode only flips the card; the live panel hands the image to the
		// scene through the same event the workflow canvas already listens for.
		if (!transport.mock) window.dispatchEvent(new CustomEvent("cozyclay:agent-image", { detail: { imageId: image.imageId, dataUrl: image.dataUrl } }));
		setItems((current) => current.map((item) => item.kind === "image" && item.id === image.id ? { ...item, placed: true } : item));
	}, [transport.mock]);

	const undoPlacement = useCallback((image) => {
		setItems((current) => current.map((item) => item.kind === "image" && item.id === image.id ? { ...item, placed: false } : item));
	}, []);

	const switchModel = useCallback(() => {
		const index = models.findIndex((entry) => entry.id === model);
		const next = models[(index + 1) % models.length];
		if (next) chooseModel(next.id);
		setRateLimit(null);
	}, [chooseModel, model, models]);

	const onComposerKeyDown = useCallback((event) => {
		if (event.key === "Escape" && streaming) {
			event.preventDefault();
			stopTurn();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			runTurn(draft);
		}
	}, [draft, runTurn, stopTurn, streaming]);

	const panelState = rateLimit ? "rate-limited"
		: authState !== "ready" ? authState
		: streaming ? "streaming"
		: items.some((item) => item.kind === "tool" && item.status === "failed") ? "error"
		: "ready";
	const statusTone = { "signed-out": "", "signing-in": "busy", "no-entitlement": "warn", ready: "ok", streaming: "busy", "rate-limited": "warn", error: "alert" }[panelState] || "";
	const resetLabel = formatResetIn(rateLimit?.resetAt || quota?.resetAt);
	// A disabled composer under the sign-in card is dead weight: the composer
	// only exists once there is a session to talk to.
	const authenticated = authState === "ready" || authState === "no-entitlement";
	const composerDisabled = panelState === "rate-limited";

	if (collapsed) {
		return <aside className="agent-panel collapsed" data-agent-state={panelState} data-agent-collapsed="true" aria-label="Agent panel, collapsed">
			<button type="button" className="agent-rail-toggle" onClick={() => setCollapsed(false)} aria-label="Expand agent panel" title="Expand agent panel (Cmd/Ctrl+B)"><FiChevronRight size={13} style={{ transform: "rotate(180deg)" }} /></button>
			<StatusDot tone={statusTone} title={panelState} />
			<span className="agent-rail-label">Agent</span>
		</aside>;
	}

	return <aside
		className={`agent-panel${resizing ? " resizing" : ""}${overlay ? " overlay" : ""}`}
		style={{ width: `${width}px` }}
		data-agent-state={panelState}
		data-agent-width={width}
		data-agent-overlay={overlay ? "true" : "false"}
		aria-label="Agent"
	>
		<div
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
		/>

		<header className="agent-header">
			<StatusDot tone={statusTone} title={panelState} />
			<h2 className="agent-title">Agent</h2>
			<span className="agent-header-spacer" />
			<button type="button" className="agent-ghost-button agent-new" onClick={newSession}><FiPlus size={11} /> New</button>
			<button type="button" className="agent-ghost-button agent-history" disabled title="History is coming with the sidecar">History</button>
			<span className="agent-overflow">
				<button type="button" className="agent-icon-button agent-overflow-toggle" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="More agent actions" onClick={() => setMenuOpen((value) => !value)}><FiMoreHorizontal size={13} /></button>
				{menuOpen && <div className="agent-menu" role="menu">
					<button type="button" role="menuitem" onClick={() => { setItems([]); setMenuOpen(false); }}>Clear context</button>
					<button type="button" role="menuitem" onClick={signOut}>Sign out</button>
				</div>}
			</span>
			<button type="button" className="agent-icon-button agent-collapse" onClick={() => setCollapsed(true)} aria-label="Collapse agent panel" title="Collapse agent panel (Cmd/Ctrl+B)"><FiChevronRight size={13} /></button>
		</header>

		{account?.signedIn && <div className="agent-account">
			<span className="agent-account-email">{account.email}</span>
			<span className="agent-plan-badge">{quota?.plan || account.plan || "Free"}</span>
			{resetLabel && <span className="agent-account-reset">resets in {resetLabel}</span>}
		</div>}

		<div className="agent-transcript" ref={transcriptRef} aria-live="polite" aria-label="Conversation" data-agent-transcript="true">
			{authState === "signed-out" && <div className="agent-state-card" data-agent-card="signed-out">
				<h3>Sign in with ChatGPT</h3>
				<p>The agent runs against your ChatGPT plan. Sign-in happens in your browser — no token is ever stored in this page.</p>
				<button type="button" className="agent-primary-button agent-signin" onClick={signIn}>Sign in with ChatGPT</button>
			</div>}

			{authState === "signing-in" && <div className="agent-state-card" data-agent-card="signing-in">
				<span className="agent-spinner" aria-hidden="true" />
				<h3>Waiting for your browser…</h3>
				<p>Finish the ChatGPT sign-in in the tab that just opened. This panel picks up the session automatically.</p>
			</div>}

			{authState === "no-entitlement" && <div className="agent-state-card" data-agent-card="no-entitlement">
				<h3>Image generation is not on this plan</h3>
				<p>Signed in as {account?.email || "your account"}. Chat and tool calls work; image results need a plan with image generation.</p>
				<button type="button" className="agent-primary-button" onClick={() => window.open("https://chatgpt.com/#pricing", "_blank", "noopener,noreferrer")}>See plans</button>
			</div>}

			{authState === "ready" && !items.length && !rateLimit && <div className="agent-state-card" data-agent-card="ready">
				<h3>Direct the scene</h3>
				<p>Ask for blocking, a camera move, or a rendered frame from “{sceneName}”.</p>
				<div className="agent-suggestions">
					{SUGGESTION_CHIPS.map((chip) => <button type="button" key={chip} className="agent-chip" onClick={() => { setDraft(chip); composerRef.current?.focus(); }}>{chip}</button>)}
				</div>
			</div>}

			{items.map((item) => {
				if (item.kind === "user") return <div className="agent-row user" key={item.id}><div className="agent-bubble">{item.text}</div></div>;
				if (item.kind === "assistant") return <div className="agent-row assistant" key={item.id}><div className="agent-assistant-text">{item.text}{streaming && <span className="agent-caret">▌</span>}</div></div>;
				if (item.kind === "tool") return <div className="agent-row" key={item.id}><ToolCallCard call={item} onRetry={() => runTurn(lastPromptRef.current)} /></div>;
				return <div className="agent-row" key={item.id}><ImageResultCard image={item} onUse={useInScene} onUndo={undoPlacement} onRegenerate={() => runTurn(lastPromptRef.current)} onOpen={setLightbox} /></div>;
			})}

			{rateLimit && <PausedCard resetAt={rateLimit.resetAt} onRetry={() => { setRateLimit(null); runTurn(lastPromptRef.current); }} onSwitchModel={switchModel} />}
		</div>

		{authenticated && <div className="agent-composer">
			<textarea
				ref={composerRef}
				className="agent-input"
				aria-label="Message the agent"
				placeholder={composerDisabled ? "Composer is paused" : "Ask the agent to block, frame or render…"}
				value={draft}
				disabled={composerDisabled}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={onComposerKeyDown}
			/>
			<div className="agent-composer-controls agent-composer-picks">
				<select className="agent-model-select" aria-label="Model" value={model} onChange={(event) => chooseModel(event.target.value)}>
					{models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
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
				{streaming
					? <button type="button" className="agent-send stop agent-stop" onClick={stopTurn}>Stop</button>
					: <button type="button" className="agent-send" disabled={composerDisabled || !draft.trim()} onClick={() => runTurn(draft)}>Send</button>}
			</div>
		</div>}
		{authenticated && <p className="agent-footer-hint">{IMAGE_COST_HINT}</p>}

		{lightbox && <button type="button" className="agent-lightbox" aria-label="Close image preview" onClick={() => setLightbox(null)}>
			<img src={lightbox.dataUrl} alt={lightbox.prompt || "Generated image"} />
		</button>}
	</aside>;
}

export { AGENT_STATES, AGENT_PANEL_RAIL_WIDTH };
