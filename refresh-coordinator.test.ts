import assert from "node:assert/strict";
import test from "node:test";
import { RefreshCoordinator } from "./refresh-coordinator.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("a stale generation cannot report a decrease into a new generation", async () => {
	const pending = [deferred<boolean>(), deferred<boolean>()];
	const generations: number[] = [];
	const signals: AbortSignal[] = [];
	let decreases = 0;
	const coordinator = new RefreshCoordinator(
		async (generation, signal) => {
			generations.push(generation);
			signals.push(signal);
			return pending[generations.length - 1]!.promise;
		},
		() => decreases++,
	);

	const staleGeneration = await coordinator.activate();
	const staleRequest = coordinator.request();
	const nextActivation = coordinator.activate();
	assert.equal(signals[0]!.aborted, true);
	pending[0]!.resolve(true);
	const currentGeneration = await nextActivation;
	const currentRequest = coordinator.request();

	assert.equal(coordinator.isCurrent(staleGeneration), false);
	assert.equal(coordinator.isCurrent(currentGeneration), true);
	assert.deepEqual(generations, [1, 2]);
	await staleRequest;
	assert.equal(decreases, 0);
	pending[1]!.resolve(false);
	await currentRequest;
});

test("overlapping refresh transitions serialize and only the newest becomes active", async () => {
	const pending = deferred<boolean>();
	const coordinator = new RefreshCoordinator(async () => pending.promise, () => undefined);
	const firstGeneration = await coordinator.activate();
	const request = coordinator.request();
	const secondActivation = coordinator.restart();
	const thirdActivation = coordinator.restart();
	pending.resolve(false);
	const [secondGeneration, thirdGeneration] = await Promise.all([secondActivation, thirdActivation]);
	await request;
	assert.equal(coordinator.isCurrent(firstGeneration), false);
	assert.equal(coordinator.isCurrent(secondGeneration), false);
	assert.equal(coordinator.isCurrent(thirdGeneration), true);
});

test("restart aborts and awaits an active sample before a fresh request", async () => {
	const pending = [deferred<boolean>(), deferred<boolean>()];
	const signals: AbortSignal[] = [];
	let calls = 0;
	const coordinator = new RefreshCoordinator(
		async (_generation, signal) => {
			signals.push(signal);
			return pending[calls++]!.promise;
		},
		() => undefined,
	);
	await coordinator.activate();
	const staleRequest = coordinator.request();
	let restarted = false;
	const restart = coordinator.restart().then((generation) => {
		restarted = true;
		return generation;
	});
	assert.equal(signals[0]!.aborted, true);
	await settle();
	assert.equal(restarted, false);
	pending[0]!.resolve(false);
	const generation = await restart;
	await staleRequest;
	assert.equal(coordinator.isCurrent(generation), true);
	const freshRequest = coordinator.request();
	assert.equal(calls, 2);
	pending[1]!.resolve(false);
	await freshRequest;
});

test("deactivate aborts and awaits the current sample", async () => {
	const pending = deferred<boolean>();
	let signal!: AbortSignal;
	const coordinator = new RefreshCoordinator(
		async (_generation, operationSignal) => {
			signal = operationSignal;
			return pending.promise;
		},
		() => undefined,
	);
	const generation = await coordinator.activate();
	const request = coordinator.request();
	let deactivated = false;
	const deactivate = coordinator.deactivate().then(() => {
		deactivated = true;
	});
	assert.equal(signal.aborted, true);
	assert.equal(coordinator.isCurrent(generation), false);
	await settle();
	assert.equal(deactivated, false);
	pending.resolve(false);
	await deactivate;
	await request;
	assert.equal(deactivated, true);
});

test("checkpoints during a slow request coalesce into one fresh trailing sample", async () => {
	const pending = [deferred<boolean>(), deferred<boolean>()];
	let calls = 0;
	const coordinator = new RefreshCoordinator(
		async () => pending[calls++]!.promise,
		() => undefined,
	);
	await coordinator.activate();

	const immediate = coordinator.request();
	void coordinator.request(true);
	void coordinator.request(true);
	void coordinator.request(true);
	assert.equal(calls, 1);

	pending[0]!.resolve(false);
	await immediate;
	await settle();
	assert.equal(calls, 2);
	pending[1]!.resolve(false);
	await settle();
	assert.equal(calls, 2);
});

test("manual or new-turn cancellation drops queued work and starts fresh", async () => {
	const pending = [deferred<boolean>(), deferred<boolean>()];
	let calls = 0;
	const coordinator = new RefreshCoordinator(
		async () => pending[calls++]!.promise,
		() => undefined,
	);
	await coordinator.activate();
	const settledRequest = coordinator.request();
	void coordinator.request(true);
	const restart = coordinator.restart();
	pending[0]!.resolve(false);
	await restart;
	await settledRequest;
	const manualRequest = coordinator.request();
	assert.equal(calls, 2);
	pending[1]!.resolve(false);
	await manualRequest;
	await settle();
	assert.equal(calls, 2);
});

test("a detected deduction cancels the coordinator trailing sample before notifying", async () => {
	const pending = deferred<boolean>();
	let calls = 0;
	let decreases = 0;
	const coordinator = new RefreshCoordinator(
		async () => {
			calls++;
			return pending.promise;
		},
		() => decreases++,
	);
	await coordinator.activate();

	const immediate = coordinator.request();
	void coordinator.request(true);
	pending.resolve(true);
	await immediate;
	await settle();
	assert.equal(decreases, 1);
	assert.equal(calls, 1);
});
