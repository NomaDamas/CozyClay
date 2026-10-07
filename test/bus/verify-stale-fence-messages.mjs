import assert from 'node:assert/strict';
import { fixture, result, deferred } from './fixture.mjs';

// A running job is refused with STALE_TARGET by three different fences. They
// share one code, so the message is the only way for the user or the agent to
// tell which one tripped; each must name its own cause.
async function staleMessage(trip) {
	const f = fixture();
	const entered = deferred(), release = deferred();
	f.registry.register({ id: 'fixture.motionJob', label: 'Motion job', description: 'Waits, then checks its fences', kind: 'job', domain: 'motion',
		target: args => args.characterId, input: { type: 'object', properties: { characterId: { type: 'string' } }, required: [], additionalProperties: false },
		available: () => true,
		run: async (_args, context) => { entered.resolve(); await release.promise; context.check(); return result(['target']); } });
	const pending = f.bus.run('fixture.motionJob', { characterId: 'target' }, f.request());
	await entered.promise;
	trip(f);
	release.resolve();
	const outcome = await pending;
	f.bus.dispose();
	return outcome;
}

const domain = await staleMessage(f => f.edit(1, 'motion'));
assert.equal(domain.code, 'STALE_TARGET');
assert.match(domain.message, /motion data changed while the job was running \(revision 0 to 1\)/, domain.message);

const target = await staleMessage(f => f.patch({ tokens: { target: 'target-2' } }));
assert.equal(target.code, 'STALE_TARGET');
assert.match(target.message, /^target changed while the job was running\.$/, target.message);

const document = await staleMessage(f => f.patch({ host: { ...f.state.host, sceneEpoch: 'epoch-2' } }));
assert.equal(document.code, 'STALE_TARGET');
assert.match(document.message, /document or scene changed while the job was running/, document.message);

console.log('PASS stale job fences: the domain, target and document refusals each name their cause');
