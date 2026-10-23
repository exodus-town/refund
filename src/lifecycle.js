/** Governor states: Pending, Active, Canceled, Defeated, Succeeded, Queued, Expired, Executed. */
export function relevantStep({ active = false, state } = {}) {
  if (active || state === 7) return "refund";
  if (state === 4 || state === 5) return "execute";
  // Once posted, Vote is the useful next screen: delegate while pending,
  // cast a vote while active, or inspect the outcome if voting did not succeed.
  if ([0, 1, 2, 3, 6].includes(state)) return "vote";
  return "proposal";
}

export function followLifecycle(currentTab, previousPhase, live) {
  const step = relevantStep(live);
  const phase = live.active ? "refund-open" : (live.state ?? "unposted");
  return { tab: phase !== previousPhase ? step : currentTab, phase };
}

export function estimatedBlockTime(
  targetBlock,
  currentBlock,
  timestamp,
  secondsPerBlock,
) {
  return (
    (timestamp + (Number(targetBlock) - currentBlock) * secondsPerBlock) * 1000
  );
}
