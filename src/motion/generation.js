// Pure request construction. The caller supplies one rolled seed and sampled
// poses; no rig, store, random source, notification or network is touched here.
import { StudioProtocolError, compileStudioBeats } from '../studio-agent-protocol.js';
import { TIMELINE_FRAME_FPS as FPS } from '../timeline-fps.js';
import { judgeAuthoredPath, alignArdyPath } from '../ardy/waypoints.js';
import { planPosePin, PIN_BLOCKED } from '../ardy/pose-pin.js';
import { blocksFromRequest, replayPayload, replayTruncated } from '../take-recipe.js';

// Same half-open timeline schedule used by the editor: gaps carry the base
// prompt, and spans shorter than three frames cannot carry a generation.
function promptSchedule(clips, clipFrames, prompt) {
  const segments = [];
  let cursor = 0;
  for (const clip of clips) {
    const startFrame = Math.max(cursor, Math.min(clipFrames, clip.startFrame));
    const endFrame = Math.max(startFrame, Math.min(clipFrames, clip.endFrame));
    if (startFrame > cursor) segments.push({ startFrame: cursor, endFrame: startFrame, prompt });
    if (endFrame - startFrame >= 3) segments.push({ startFrame, endFrame, prompt: clip.text.trim() || prompt });
    cursor = Math.max(cursor, endFrame);
    if (cursor >= clipFrames) break;
  }
  if (cursor < clipFrames) segments.push({ startFrame: cursor, endFrame: clipFrames, prompt });
  if (!segments.length) segments.push({ startFrame: 0, endFrame: clipFrames, prompt });
  return segments;
}

export function generationArgs({ characterId, source }) {
  if (source.kind !== 'generate') throw generationRefusal('CAPABILITY_MISSING', 'Artifact reuse is handled by the retained artifact runtime.');
  const schedule = compileStudioBeats(source);
  return { characterId, durationSeconds: schedule.durationSeconds,
    blocks: schedule.blocks.map((block, index) => ({ id: `generation-block-${index}`, text: block.text, startFrame: block.startFrame, endFrame: block.endFrameExclusive })),
    ...(source.seed === undefined ? {} : { seed: source.seed }) };
}

export function generationRefusal(code, message, uiMessage = message) {
  return Object.assign(new StudioProtocolError(code, message), { uiMessage });
}

export function buildGenerationRequest({ character, prompt, durationSeconds, seed,
  waypoints = [], waypointMode = waypoints.length > 0, blocks = [], motion = null,
  ikKeys = new Map(), startFromPose = false, posePlacement = 'start', frame = 0, poses = [],
  preserveStrength = 0.5, recipe = null, fresh = false,
}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw generationRefusal('INVALID_ARGUMENT', 'Motion prompt is required - describe what the subject should do before generating');
  if (text.length > 500) throw generationRefusal('INVALID_ARGUMENT', `Motion prompt is capped at 500 characters (currently ${text.length}) - shorten it before generating`);
  const ikFrames = [...ikKeys.keys()].sort((a, b) => a - b);
  const duration = motion && ikFrames.length ? motion.frames / motion.fps : Number(durationSeconds);
  const clipFrames = Math.round(duration * FPS);
  if (!Number.isFinite(duration) || duration < 1 || duration > 1200) throw generationRefusal('INVALID_RANGE', 'Duration must be between 1 and 1200 seconds');
  if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1) throw generationRefusal('INVALID_ARGUMENT', 'Seed must be an integer in 0..2147483647');
  const warnings = [];
  const clips = blocks.filter(clip => clip.text.trim()).sort((a, b) => a.startFrame - b.startFrame);
  const segments = promptSchedule(clips, clipFrames, text), hasPromptSchedule = segments.length > 1;
  const rootPath = waypointMode ? [{ frame: 0, x: character.x, z: character.z, heading: null }, ...waypoints] : [];
  if (waypointMode) {
    if (!waypoints.length) throw generationRefusal('INVALID_RANGE', 'Add at least one root destination before generating');
    if (rootPath.length > 32) throw generationRefusal('INVALID_RANGE', 'The root path is capped at 32 sparse waypoints');
    if (waypoints.some(point => point.frame <= 0 || point.frame >= clipFrames)) throw generationRefusal('INVALID_RANGE', `Root waypoint frames must stay inside 1..${clipFrames - 1}`);
    const verdict = judgeAuthoredPath(rootPath, FPS, clipFrames, { chained: hasPromptSchedule });
    if (verdict.errors.length) throw generationRefusal('INVALID_RANGE', `Not generated - ${verdict.errors[0]}`);
    warnings.push(...verdict.warnings);
  }
  const longBlock = clips.length && segments.find(segment => segment.endFrame - segment.startFrame > 5 * FPS);
  if (longBlock) throw generationRefusal('INVALID_RANGE', `Not generated - prompt blocks are capped at 5 s; split the ${((longBlock.endFrame - longBlock.startFrame) / FPS).toFixed(1)} s block`);
  if (segments.some(segment => segment.prompt.length > 500)) throw generationRefusal('INVALID_ARGUMENT', 'Each motion prompt block is capped at 500 characters');
  const aligned = waypointMode ? alignArdyPath(rootPath, character.rot, 32) : null;
  const editedSegments = motion?.url && hasPromptSchedule
    ? segments.filter(segment => ikFrames.some(at => at >= segment.startFrame && at < segment.endFrame)) : [];
  const hasBlockEdits = editedSegments.length > 0;
  const last = clipFrames - 1;
  const poseFrame = posePlacement === 'end' ? last : posePlacement === 'middle' ? Math.round(last / 2)
    : posePlacement === 'playhead' ? Math.max(0, Math.min(last, frame)) : 0;
  const plan = planPosePin({ startFromPose, poseFrame, hasPromptSchedule, hasBlockEdits, waypointMode, ikFrames, clipFrames, segments, editedSegments });
  if (plan.blockedBy === PIN_BLOCKED.SCHEDULE) warnings.push('Prompt blocks and a pose start cannot be combined - generating from the prompt alone.');
  const body = { prompt: text, duration, posePin: plan.pin, seed };
  let committedEditKeys = [];
  if (plan.pin && !hasBlockEdits) body.poses = poses.map(entry => ({ ...entry }));
  if (aligned) {
    Object.assign(body, { waypoints: aligned.waypoints, rootMargin: 0.08, historyFrames: 4 * FPS });
    if (hasPromptSchedule && !hasBlockEdits) body.segments = segments;
  } else if (hasBlockEdits) {
    const entries = plan.frames.map(at => ({ frame: at, tracks: [...(ikKeys.get(at)?.keys() ?? [])], pose: poses.find(entry => entry.frame === at)?.pose }));
    committedEditKeys = entries.map(({ frame, tracks }) => ({ frame, tracks }));
    body.motionEdit = { sourceMotion: motion.url, startFrame: Math.min(...editedSegments.map(segment => segment.startFrame)),
      endFrame: Math.max(...editedSegments.map(segment => segment.endFrame)), contextBefore: 40, contextAfter: 20, edits: entries };
  } else if (hasPromptSchedule) body.segments = segments;
  const requestBlocks = blocksFromRequest(body, FPS), recipeBlocks = recipe?.blocks;
  const durationFits = motion?.frames > 0 && Math.abs(motion.frames / FPS - duration) <= 1 / FPS + 1e-9;
  const promptMatches = body.motionEdit !== undefined || (recipeBlocks?.length === requestBlocks.length && recipeBlocks.every((block, i) => block.prompt.trim() === requestBlocks[i].prompt.trim()));
  if (!fresh && motion?.url && preserveStrength > 0 && durationFits && promptMatches && !body.segments) {
    body.preserve = { sourceMotion: motion.url, strength: preserveStrength,
      editRanges: editedSegments.map(({ startFrame, endFrame }) => {
        const tracks = [...new Set(ikFrames.filter(at => at >= startFrame && at < endFrame).flatMap(at => [...ikKeys.get(at).keys()]))];
        return { startFrame, endFrame, ...(tracks.length ? { tracks } : {}) };
      }).filter(range => range.endFrame > range.startFrame) };
  }
  const replay = fresh || hasBlockEdits || !Number.isInteger(recipe?.seed) ? [] : replayPayload(recipe);
  if (replay.length) {
    body.replay = replay;
    if (replayTruncated(recipe)) warnings.push(`Only ${replay.length} refinements can be replayed at once - the first ${replay.length} carry over`);
  }
  return { body, rootRotationDeg: aligned?.rotationDeg ?? character.rot, warnings,
    constraintFrames: plan.frames, hasBlockEdits, hasPromptSchedule, committedEditKeys };
}
