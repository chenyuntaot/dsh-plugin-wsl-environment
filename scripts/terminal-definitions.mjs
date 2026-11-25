/** Register the native Terminal descriptors after the old Terminal controller is withdrawn. */
export function registerTerminalDefinitions(registry, contribution) {
  const endpoints = new Set(contribution.invocations.map(({ namespace, method }) => `${namespace}/${method}`));
  let registered = false;
  const install = () => {
    if (registered || [...endpoints].some(endpoint => registry.local.get(endpoint) !== undefined)) return;
    registered = true;
    registry.register(contribution);
  };
  // Cordis owns the subscription and contribution through the calling plugin's lifecycle.
  registry.local.subscribe(({ key }) => { if (endpoints.has(key)) install(); });
  install();
}
