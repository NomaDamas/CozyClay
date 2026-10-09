// Viewer preferences: transient, like the View menu they mirror.
import { studioActionDeclaration, studioActionRefusal } from "../studio-actions.js";
import { StudioProtocolError, STUDIO_TOOL_SCHEMAS } from '../studio-agent-protocol.js';
import { ko } from '../locale.js';
import { shotAtFrame } from '../cuts.js';

const fields = STUDIO_TOOL_SCHEMAS.operate_studio.properties;
const groups = { 'view.select': ['selection', 'shotId'], 'timeline.seek': ['frame'], 'timeline.play': ['playing'], 'view.setMode': ['mode', 'view'] };
const operations = Object.entries({ ...groups, 'view.update': Object.keys(fields) }).map(([id, keys]) => ({
	id, label: id, description: 'Change selection, timeline or viewer state without authoring history.', kind: 'transient',
	input: { type: 'object', properties: Object.fromEntries(keys.map(key => [key, fields[key]])), required: [], additionalProperties: false },
}));
export const declarations = Object.freeze([...operations, ...["view.setPartColours", "view.setGuideMode", "view.setInset"].map(studioActionDeclaration)]);
// A storyboard project has no Motion department; every door says so the same way.
export const STORYBOARD_MOTION_REFUSAL = Object.freeze({ en: 'Motion tools are not part of a Storyboard project.', ko: '모션 도구는 스토리보드 프로젝트에 없어요.' });
export const viewCommand = args => Object.entries(groups).find(([, keys]) => Object.keys(args).every(key => keys.includes(key)))?.[0] ?? 'view.update';

export function register(registry, ports) {
	registry.registerToolAlias('operate_studio', viewCommand);
	for (const declaration of operations) registry.register({ ...declaration, available: () => true, run(args) {
		const fail = (code, message) => { throw new StudioProtocolError(code, message); };
		if (!Object.keys(args).length || (args.view && !Object.keys(args.view).length)) fail('INVALID_ARGUMENT', 'Specify a view operation.');
		const state = ports.readView();
		// Pose mode is IK editing: without a rig to solve there is nothing to pose.
		if (args.mode === 'pose' && args.mode !== state.view.mode && !ports.canPose()) fail('TARGET_NOT_READY', 'Pose mode needs a loaded character rig to edit with IK.');
		if (args.mode === 'motion' && state.previsMode === 'storyboard') throw studioActionRefusal('TARGET_NOT_READY', STORYBOARD_MOTION_REFUSAL.en, ko(STORYBOARD_MOTION_REFUSAL.en, STORYBOARD_MOTION_REFUSAL.ko));
		const selection = args.selection === undefined ? state.selection : args.selection;
		if (selection) {
			const found = selection.kind === 'scene' ? selection.id === state.host.sceneId : selection.kind === 'camera' ? selection.id === 'camera'
				: (selection.kind === 'object' ? state.objects : state.characters).some(row => row.id === selection.id);
			if (!found) fail('STALE_TARGET', 'Selection is not present in this document.');
		}
		const shot = args.shotId === undefined ? null : state.shots.find(row => row.id === args.shotId);
		if (args.shotId !== undefined && !shot) fail('STALE_TARGET', 'Shot is not present in this document.');
		const frame = args.frame ?? shot?.startFrame ?? state.view.frame;
		if (frame >= Math.max(1, state.frameCount)) fail('INVALID_RANGE', 'Frame is outside the timeline.');
		const view = { ...state.view, ...args.view, frame, mode: args.mode ?? state.view.mode, playing: args.playing ?? state.view.playing };
		ports.publishView({ selection, view, shotId: args.shotId ?? shotAtFrame(state.shots, frame)?.id ?? null });
		return { affectedIds: [state.host.sceneId], summary: 'Updated editor view.' };
	} });
	const viewAction = (id, run) => registry.register({ ...studioActionDeclaration(id), available: () => true,
		run: args => ({ affectedIds: [], summary: run(args) }) });
	viewAction("view.setPartColours", ({ mode }) => { ports.choosePartColours(mode); return `Part colours: ${mode}.`; });
	viewAction("view.setGuideMode", ({ mode }) => { ports.setGuideMode(mode); return `Composition guide: ${mode}.`; });
	viewAction("view.setInset", ({ collapsed }) => { ports.setInsetCollapsed(collapsed); return `Top-View inset ${collapsed ? "folded" : "unfolded"}.`; });
}
