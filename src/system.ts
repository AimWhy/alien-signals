export interface Dependency {
	subs: (Subscriber | Dependency & Subscriber)[];
	subSlots: number[];
}

export interface Subscriber {
	flags: SubscriberFlags;
	deps: (Dependency | Dependency & Subscriber)[];
	depSlots: number[];
	depsLength: number;
}

export const enum SubscriberFlags {
	Computed = 1 << 0,
	Effect = 1 << 1,
	Tracking = 1 << 2,
	Notified = 1 << 3,
	Recursed = 1 << 4,
	Dirty = 1 << 5,
	PendingComputed = 1 << 6,
	PendingEffect = 1 << 7,
	Propagated = Dirty | PendingComputed | PendingEffect,
}

export function createReactiveSystem({
	updateComputed,
	notifyEffect,
}: {
	/**
	 * Updates the computed subscriber's value and returns whether it changed.
	 * 
	 * This function should be called when a computed subscriber is marked as Dirty.
	 * The computed subscriber's getter function is invoked, and its value is updated.
	 * If the value changes, the new value is stored, and the function returns `true`.
	 * 
	 * @param computed - The computed subscriber to update.
	 * @returns `true` if the computed subscriber's value changed; otherwise `false`.
	 */
	updateComputed(computed: Dependency & Subscriber): boolean;
	/**
	 * Handles effect notifications by processing the specified `effect`.
	 * 
	 * When an `effect` first receives any of the following flags:
	 *   - `Dirty`
	 *   - `PendingComputed`
	 *   - `PendingEffect`
	 * this method will process them and return `true` if the flags are successfully handled.
	 * If not fully handled, future changes to these flags will trigger additional calls
	 * until the method eventually returns `true`.
	 */
	notifyEffect(effect: Subscriber): boolean;
}) {
	const notifyBuffer: (Subscriber | undefined)[] = [];

	let notifyIndex = 0;
	let notifyBufferLength = 0;

	return {
		link,
		propagate,
		updateDirtyFlag,
		startTracking,
		endTracking,
		processEffectNotifications,
		processComputedUpdate,
		processPendingInnerEffects,
	};

	/**
	 * Links a given dependency and subscriber if they are not already linked.
	 * 
	 * @param dep - The dependency to be linked.
	 * @param sub - The subscriber that depends on this dependency.
	 * @returns The newly created link object if the two are not already linked; otherwise `undefined`.
	 */
	function link(dep: Dependency, sub: Subscriber): void {
		const depsLength = sub.depsLength;
		const deps = sub.deps;
		const currentDep = deps[depsLength - 1];
		if (currentDep === dep) {
			return;
		}
		const nextDep = deps[depsLength];
		if (nextDep === dep) {
			sub.depsLength = depsLength + 1;
			return;
		}
		const subs = dep.subs;
		const subsLength = subs.length;
		const lastSub = subs[subsLength - 1];
		if (lastSub === sub /* && isValidLink(dep, sub) */) {
			return;
		}
		subs[subsLength] = sub;
		deps[depsLength] = dep;
		dep.subSlots[subsLength] = subsLength;
		sub.depSlots[depsLength] = depsLength;
		sub.depsLength = depsLength + 1;
	}

	/**
	 * Traverses and marks subscribers starting from the provided link.
	 * 
	 * It sets flags (e.g., Dirty, PendingComputed, PendingEffect) on each subscriber
	 * to indicate which ones require re-computation or effect processing. 
	 * This function should be called after a signal's value changes.
	 * 
	 * @param current - The starting link from which propagation begins.
	 */
	function propagate(dep: Dependency, subs: (Subscriber | Dependency & Subscriber)[], subsLength: number, targetFlag = SubscriberFlags.Dirty): void {
		for (let i = 0; i < subsLength; i++) {
			const sub = subs[i];
			const subFlags = sub.flags;

			let shouldNotify = false;

			if (!(subFlags & (SubscriberFlags.Tracking | SubscriberFlags.Recursed | SubscriberFlags.Propagated))) {
				sub.flags = subFlags | targetFlag | SubscriberFlags.Notified;
				shouldNotify = true;
			} else if ((subFlags & SubscriberFlags.Recursed) && !(subFlags & SubscriberFlags.Tracking)) {
				sub.flags = (subFlags & ~SubscriberFlags.Recursed) | targetFlag | SubscriberFlags.Notified;
				shouldNotify = true;
			} else if (!(subFlags & SubscriberFlags.Propagated) && isValidLink(dep, sub)) {
				sub.flags = subFlags | SubscriberFlags.Recursed | targetFlag | SubscriberFlags.Notified;
				shouldNotify = (sub as Dependency).subs !== undefined;
			}

			if (shouldNotify) {
				if ('subs' in sub) {
					const subs = sub.subs;
					const subsLength = subs.length;
					if (subsLength) {
						propagate(sub, subs, subsLength, subFlags & SubscriberFlags.Effect ? SubscriberFlags.PendingEffect : SubscriberFlags.PendingComputed);
					} else if (subFlags & SubscriberFlags.Effect) {
						notifyBuffer[notifyBufferLength++] = sub;
					}
				} else if (subFlags & SubscriberFlags.Effect) {
					notifyBuffer[notifyBufferLength++] = sub;
				}
			} else if (!(subFlags & (SubscriberFlags.Tracking | targetFlag))) {
				sub.flags = subFlags | targetFlag | SubscriberFlags.Notified;
				if ((subFlags & (SubscriberFlags.Effect | SubscriberFlags.Notified)) === SubscriberFlags.Effect) {
					notifyBuffer[notifyBufferLength++] = sub;
				}
			} else if (
				!(subFlags & targetFlag)
				&& (subFlags & SubscriberFlags.Propagated)
				&& isValidLink(dep, sub)
			) {
				sub.flags = subFlags | targetFlag;
			}
		}
	}

	/**
	 * Prepares the given subscriber to track new dependencies.
	 * 
	 * It resets the subscriber's internal pointers (e.g., depsTail) and
	 * sets its flags to indicate it is now tracking dependency links.
	 * 
	 * @param sub - The subscriber to start tracking.
	 */
	function startTracking(sub: Subscriber): void {
		sub.depsLength = 0;
		sub.flags = (sub.flags & ~(SubscriberFlags.Notified | SubscriberFlags.Recursed | SubscriberFlags.Propagated)) | SubscriberFlags.Tracking;
	}

	/**
	 * Concludes tracking of dependencies for the specified subscriber.
	 * 
	 * It clears or unlinks any tracked dependency information, then
	 * updates the subscriber's flags to indicate tracking is complete.
	 * 
	 * @param sub - The subscriber whose tracking is ending.
	 */
	function endTracking(sub: Subscriber): void {
		const depsLength = sub.depsLength;
		const deps = sub.deps;
		let l = deps.length;
		if (l !== depsLength) {
			// Not implemented
			// const depSlots = sub.depSlots;
			// do {
			// 	const dep = deps[l - 1];
			// 	const depSubs = dep.subs;
			// 	const depSubSlots = dep.subSlots;
			// 	const depSubSlotsLength = depSubSlots.length;
			// 	const subIndex = depSlots[l - 1];
			// 	if (subIndex < depSubSlotsLength - 1) {
			// 		depSubs[subIndex] = depSubs[depSubSlotsLength - 1];
			// 		depSubSlots[subIndex] = depSubSlots[depSubSlotsLength - 1];
			// 	}
			// 	depSubs.length = depSubSlotsLength - 1;
			// 	depSubSlots.length = depSubSlotsLength - 1;
			// } while (--l > depsLength);
			// deps.length = depsLength;
			// depSlots.length = depsLength;
		}
		sub.flags &= ~SubscriberFlags.Tracking;
	}

	/**
	 * Updates the dirty flag for the given subscriber based on its dependencies.
	 * 
	 * If the subscriber has any pending computeds, this function sets the Dirty flag
	 * and returns `true`. Otherwise, it clears the PendingComputed flag and returns `false`.
	 * 
	 * @param sub - The subscriber to update.
	 * @param flags - The current flag set for this subscriber.
	 * @returns `true` if the subscriber is marked as Dirty; otherwise `false`.
	 */
	function updateDirtyFlag(sub: Subscriber, flags: SubscriberFlags): boolean {
		if (checkDirty(sub.deps!, sub.depsLength)) {
			sub.flags = flags | SubscriberFlags.Dirty;
			return true;
		} else {
			sub.flags = flags & ~SubscriberFlags.PendingComputed;
			return false;
		}
	}

	/**
	 * Updates the computed subscriber if necessary before its value is accessed.
	 * 
	 * If the subscriber is marked Dirty or PendingComputed, this function runs
	 * the provided updateComputed logic and triggers a shallowPropagate for any
	 * downstream subscribers if an actual update occurs.
	 * 
	 * @param computed - The computed subscriber to update.
	 * @param flags - The current flag set for this subscriber.
	 */
	function processComputedUpdate(computed: Dependency & Subscriber, flags: SubscriberFlags): void {
		if (flags & SubscriberFlags.Dirty || checkDirty(computed.deps!, computed.depsLength)) {
			if (updateComputed(computed)) {
				const subs = computed.subs!;
				const subsLength = subs.length;
				if (subsLength) {
					shallowPropagate(subs, subsLength);
				}
			}
		} else {
			computed.flags = flags & ~SubscriberFlags.PendingComputed;
		}
	}

	/**
	 * Ensures all pending internal effects for the given subscriber are processed.
	 * 
	 * This should be called after an effect decides not to re-run itself but may still
	 * have dependencies flagged with PendingEffect. If the subscriber is flagged with
	 * PendingEffect, this function clears that flag and invokes `notifyEffect` on any
	 * related dependencies marked as Effect and Propagated, processing pending effects.
	 * 
	 * @param sub - The subscriber which may have pending effects.
	 * @param flags - The current flags on the subscriber to check.
	 */
	function processPendingInnerEffects(sub: Subscriber, flags: SubscriberFlags): void {
		if (flags & SubscriberFlags.PendingEffect) {
			sub.flags = flags & ~SubscriberFlags.PendingEffect;
			const l = sub.depsLength;
			for (let i = 0; i < l; i++) {
				const dep = sub.deps[i];
				if (
					'flags' in dep
					&& dep.flags & SubscriberFlags.Effect
					&& dep.flags & SubscriberFlags.Propagated
				) {
					notifyEffect(dep);
				}
			}
		}
	}

	/**
	 * Processes queued effect notifications after a batch operation finishes.
	 * 
	 * Iterates through all queued effects, calling notifyEffect on each.
	 * If an effect remains partially handled, its flags are updated, and future
	 * notifications may be triggered until fully handled.
	 */
	function processEffectNotifications(): void {
		while (notifyIndex < notifyBufferLength) {
			const effect = notifyBuffer[notifyIndex]!;
			notifyBuffer[notifyIndex++] = undefined;
			if (!notifyEffect(effect)) {
				effect.flags &= ~SubscriberFlags.Notified;
			}
		}
		notifyIndex = 0;
		notifyBufferLength = 0;
	}

	/**
	 * Recursively checks and updates all computed subscribers marked as pending.
	 * 
	 * It traverses the linked structure using a stack mechanism. For each computed
	 * subscriber in a pending state, updateComputed is called and shallowPropagate
	 * is triggered if a value changes. Returns whether any updates occurred.
	 * 
	 * @param current - The starting link representing a sequence of pending computeds.
	 * @returns `true` if a computed was updated, otherwise `false`.
	 */
	function checkDirty(deps: (Dependency | Dependency & Subscriber)[], depsLength: number): boolean {
		let i = 0;
		do {
			const dep = deps[i];
			if ('flags' in dep) {
				const depFlags = dep.flags;
				if ((depFlags & (SubscriberFlags.Computed | SubscriberFlags.Dirty)) === (SubscriberFlags.Computed | SubscriberFlags.Dirty)) {
					if (updateComputed(dep)) {
						const subs = dep.subs!;
						const subsLength = subs.length;
						if (subsLength >= 2) {
							shallowPropagate(subs, subsLength);
						}
						return true;
					}
				} else if ((depFlags & (SubscriberFlags.Computed | SubscriberFlags.PendingComputed)) === (SubscriberFlags.Computed | SubscriberFlags.PendingComputed)) {
					if (checkDirty(dep.deps!, dep.depsLength)) {
						if (updateComputed(dep)) {
							const subs = dep.subs!;
							const subsLength = subs.length;
							if (subsLength >= 2) {
								shallowPropagate(subs, subsLength);
							}
							return true;
						}
					} else {
						dep.flags = depFlags & ~SubscriberFlags.PendingComputed;
					}
				}
			}
		} while (++i < depsLength);
		return false;
	}

	/**
	 * Quickly propagates PendingComputed status to Dirty for each subscriber in the chain.
	 * 
	 * If the subscriber is also marked as an effect, it is added to the queuedEffects list
	 * for later processing.
	 * 
	 * @param link - The head of the linked list to process.
	 */
	function shallowPropagate(subs: Subscriber[], subsLength: number): void {
		for (let i = 0; i < subsLength; i++) {
			const sub = subs[i];
			sub.flags |= SubscriberFlags.Dirty | SubscriberFlags.Notified;
			if ((sub.flags & (SubscriberFlags.Effect | SubscriberFlags.Notified)) === SubscriberFlags.Effect) {
				notifyBuffer[notifyBufferLength++] = sub;
			}
		}
	}

	/**
	 * Verifies whether the given link is valid for the specified subscriber.
	 * 
	 * It iterates through the subscriber's link list (from sub.deps to sub.depsTail)
	 * to determine if the provided link object is part of that chain.
	 * 
	 * @param checkLink - The link object to validate.
	 * @param sub - The subscriber whose link list is being checked.
	 * @returns `true` if the link is found in the subscriber's list; otherwise `false`.
	 */
	function isValidLink(dep: Dependency, sub: Subscriber): boolean {
		const depsLength = sub.depsLength;
		for (let i = 0; i < depsLength; i++) {
			if (sub.deps[i] === dep) {
				return true;
			}
		}
		return false;
	}
}
