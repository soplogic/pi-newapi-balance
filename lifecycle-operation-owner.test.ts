import assert from "node:assert/strict";
import test from "node:test";
import { LifecycleOperationOwner } from "./lifecycle-operation-owner.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("invalidation aborts and waits for an in-progress login save before ownership changes", async () => {
	const loginResponse = deferred<string>();
	const saveFinished = deferred<void>();
	const owner = new LifecycleOperationOwner();
	const generation = await owner.activate();
	let signal!: AbortSignal;
	let saveStarted = false;
	const login = owner.run(generation, async (operationSignal) => {
		signal = operationSignal;
		await loginResponse.promise;
		saveStarted = true;
		await saveFinished.promise;
		return "saved";
	});

	loginResponse.resolve("logged-in");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(saveStarted, true);
	let invalidationFinished = false;
	const invalidation = owner.deactivate().then(() => {
		invalidationFinished = true;
	});
	assert.equal(signal.aborted, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(invalidationFinished, false);

	saveFinished.resolve();
	await invalidation;
	assert.equal(await login, undefined);
	assert.equal(invalidationFinished, true);
});

test("overlapping ownership transitions serialize and only the newest becomes active", async () => {
	const pending = deferred<void>();
	const owner = new LifecycleOperationOwner();
	const firstGeneration = await owner.activate();
	const operation = owner.run(firstGeneration, async () => pending.promise);
	const secondActivation = owner.activate();
	const thirdActivation = owner.activate();
	pending.resolve();
	const [secondGeneration, thirdGeneration] = await Promise.all([secondActivation, thirdActivation]);
	await operation;
	assert.equal(owner.isCurrent(firstGeneration), false);
	assert.equal(owner.isCurrent(secondGeneration), false);
	assert.equal(owner.isCurrent(thirdGeneration), true);
});

test("a stale config load cannot publish into a newer lifecycle", async () => {
	const staleLoad = deferred<string>();
	const owner = new LifecycleOperationOwner();
	const staleGeneration = await owner.activate();
	let staleSignal!: AbortSignal;
	const stale = owner.run(staleGeneration, async (signal) => {
		staleSignal = signal;
		return staleLoad.promise;
	});

	const nextActivation = owner.activate();
	assert.equal(staleSignal.aborted, true);
	staleLoad.resolve("stale-config");
	const currentGeneration = await nextActivation;
	assert.equal(await stale, undefined);
	assert.equal(owner.isCurrent(staleGeneration), false);
	assert.equal(owner.isCurrent(currentGeneration), true);
	assert.equal(await owner.run(currentGeneration, async () => "current-config"), "current-config");
});
