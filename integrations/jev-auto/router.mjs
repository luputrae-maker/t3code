const providerGuidance = {
 codex: 'Codex via ChatGPT subscription. Native repository implementation, debugging and verification.',
 claudeAgent: 'Claude Code via Claude subscription. Native repository implementation, design, reasoning and review.',
 cursor: 'Cursor via its connected account and usage pool. Native repository editing and iteration.',
 opencode: 'OpenCode Go subscription. A good first choice for scoped implementation, tests and routine fixes when the model fits. Use stronger Go models for deeper coding or multilingual work.',
 antigravity: 'Antigravity via Google account. Consider Gemini for large context, visual work and multimodal input. Use the capabilities of the exact model.',
 grok: 'Grok via its signed-in account. Native coding and an independent perspective for review.',
};
export const nativeProviders = Object.keys(providerGuidance);

const effortOptions = {
 codex: ['reasoningEffort'],
 claudeAgent: ['effort','thinking'],
 cursor: ['reasoning_effort','effort','reasoning','thinking'],
 opencode: ['variant'],
 antigravity: ['thinking_level'],
 grok: ['reasoningEffort','reasoning_effort','effort','reasoning','thinking'],
};
const effortRanks = new Map([
 ['none',0],['minimal',1],['low',2],['medium',3],['high',4],
 ['xhigh',5],['extra-high',5],['max',6],['ultra',7],['ultrathink',7],
 ['thinking',4],[false,2],[true,3],
]);

function modelEffort(provider,model) {
 const descriptors = model.capabilities?.optionDescriptors ?? model.options ?? [];
 for (const id of effortOptions[provider]) {
  const descriptor = descriptors.find(option => option.id === id);
  if (!descriptor) continue;
  const advertised = descriptor.values ?? (descriptor.type === 'boolean'
   ? [false,true] : descriptor.options?.map(option => option.id) ?? []);
  const values = advertised.filter(value => effortRanks.has(value));
  if (values.length) return {id,values};
 }
}

// Extended context tiers (e.g. "1m") are billed outside the subscription on
// some accounts: Claude Pro rejects them instantly with "Usage credits required
// for 1M context", which T3 surfaces as a rate limit. Jev only spends existing
// subscriptions, so every model that offers a context-window choice runs at its
// standard (smallest) window. The model itself stays eligible.
const contextOptionIds = ['contextWindow','context_window'];
const contextSize = id => {
 const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(String(id).trim());
 if (!m) return Number.POSITIVE_INFINITY;
 return Number(m[1]) * ({k:1e3,m:1e6}[m[2]?.toLowerCase()] ?? 1);
};
export function standardContext(model) {
 const descriptors = model?.capabilities?.optionDescriptors ?? model?.options ?? [];
 for (const id of contextOptionIds) {
  const descriptor = descriptors.find(option => option.id === id);
  const values = descriptor?.options?.map(option => option.id).filter(Boolean) ?? [];
  if (values.length < 2) continue;
  const [smallest] = [...values].sort((a,b) => contextSize(a) - contextSize(b));
  if (Number.isFinite(contextSize(smallest))) return {id,value:smallest};
 }
}

export function applyEffort(profile,requested) {
 if (!profile.effort || !effortRanks.has(requested)) return;
 const {id,values} = profile.effort;
 const rank = effortRanks.get(requested);
 const [value] = [...values].sort((a,b) =>
  Math.abs(effortRanks.get(a)-rank) - Math.abs(effortRanks.get(b)-rank) ||
  effortRanks.get(a)-effortRanks.get(b),
 );
 return {id,value};
}

function eligibleProvider(id, status, config, now) {
 if (!Object.hasOwn(providerGuidance,id) || status?.enabled !== true ||
     status.status !== 'ready' || status.auth?.status !== 'authenticated') return false;
 const auth = status.auth.type;
 if (id === 'codex' && auth !== 'chatgpt') return false;
 if (id === 'claudeAgent' && !/^claude (pro|max|team|enterprise)\b/i.test(auth ?? '')) return false;
 if (id === 'cursor' && auth !== 'browser') return false;
 if (id === 'antigravity' && auth !== 'oauth-personal') return false;
 if (id === 'grok' && auth !== 'cached_token') return false;
 if (Date.parse(config.providerPauseUntil?.[id]) > now) return false;
 return !status.usageLimits?.windows?.some(window =>
  ['Overall','Session','Weekly'].includes(window.label) &&
  window.usedPercent >= 100 && (!window.resetsAt || Date.parse(window.resetsAt) > now),
 );
}

function eligibleModel(config, provider, model) {
 return typeof model === 'string' && model.length > 0 && model.length <= 160 &&
  !['auto','default','auto-smart'].includes(model) &&
  (provider !== 'opencode' || model.startsWith('opencode-go/')) &&
  (provider !== 'cursor' || config.cursorAllowThirdParty === true || /^(grok|composer)-/.test(model));
}

export async function availablePool(config,statuses,call,{now=Date.now(),hiddenModels={}}={}){
 const capabilities=await call('orchestrator_capabilities',{});
 for(const p of config.profiles){
  const provider=capabilities.providers.find(x=>x.providerInstanceId===p.provider);
  const status=statuses[p.provider];
  if(!provider?.canRunChildTask||!eligibleProvider(p.provider,status,config,now)||
     !eligibleModel(config,p.provider,p.model)||status.models?.length||provider.models.some(m=>m.id===p.model))continue;
  const extra=await call('orchestrator_capabilities',{search:p.model});
  if(extra.parentThreadId!==capabilities.parentThreadId)throw Error('Native capability context mismatch');
  const matching=extra.providers.find(x=>x.providerInstanceId===p.provider&&x.canRunChildTask)?.models.find(m=>m.id===p.model);
  if(matching)provider.models.push(matching);
 }
 return {capabilities,candidates:candidateTargets(config,capabilities,statuses,{now,hiddenModels})};
}
export function candidateTargets(config,capabilities,statuses,{now=Date.now(),hiddenModels={}}={}){
 const profiles = [];
 for (const {providerInstanceId:provider,canRunChildTask,models} of capabilities.providers) {
  const status = statuses[provider];
  if (!canRunChildTask || !eligibleProvider(provider,status,config,now)) continue;

  const curated = config.profiles.filter(profile => profile.provider === provider);
  // T3 delegates to any advertised slug. Its MCP capability response is a short
  // display list; its provider snapshot holds the full catalog for that account.
  const catalog = status.models?.length ? status.models : models
   .filter(model => curated.some(profile => profile.model === model.id))
   .map(model => ({slug:model.id,name:model.label,options:model.options}));
  const seen = new Set(hiddenModels[provider]);
  for (const model of catalog) {
   const slug = model.slug;
   if (model.isCustom || !eligibleModel(config,provider,slug) || seen.has(slug)) continue;
   seen.add(slug);
   const profile = curated.find(profile => profile.model === slug) ?? {
    id: `${provider}:${slug}`,
    provider,
    model: slug,
    description: `${model.name ?? slug}. ${providerGuidance[provider]}`,
    options: [],
   };
   const effort = modelEffort(provider,model);
   const context = standardContext(model);
   const options = [
    ...(profile.options ?? []).filter(option => option.id !== effort?.id && option.id !== context?.id),
    ...(context ? [context] : []),
   ];
   profiles.push(effort ? {...profile,options,effort} : (context ? {...profile,options} : profile));
  }
 }
 return profiles;
}
export function userRequest(text){
 const handoffStatus=/^Context handoff \([^\r\n]+\)[.:][\s\S]*\r?\n\r?\nUser message:\r?\n\/jev-status\s*$/;
 if(handoffStatus.test(text))return '/jev-status';
 const match=/^\s*<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>\s*<user_request>([\s\S]*)<\/user_request>(?:\s*<(?:runtime_info|pull_request_linking)\b[\s\S]*)?\s*$/i.exec(text);
 return match?match[1].trim():text.trim();
}
export const isNotice=text=>/^Delegated tasks? [\s\S]*?(?:reached (?:a )?terminal states?\.| \[(?:completed|failed|cancelled|interrupted)\]|is blocked on a question|asked a question)/.test(text);
export const settled=r=>['completed','failed','cancelled','interrupted'].includes(r.status)&&r.workState==='result_available'&&!r.hasPendingChildRuns&&!r.hasPendingQuestion&&r.pendingApproval===null;
export function workBrief(task,profile,capabilities,workspace){
 const context = [
  `Real TypeSafe Jev selected ${profile.provider} / ${profile.model} in official T3. Use native tools to complete and verify the authorized work.`,
  `T3 workspace: ${JSON.stringify(workspace)}. Start from this path even if your runtime opens in a different directory. Keep project work inside this workspace unless the user authorizes another path.`,
  'Read the repository instructions and use its normal tools and verification commands.',
  'Do not call AI Router or route again. Use native tools for authorized changes and request required approvals through T3. Use python3 or the project interpreter. Use existing subscriptions and leave credits and billing settings alone.',
  capabilities.interactionMode==='plan' ? 'This is planning-only. Keep project files read-only.' : '',
  'Keep follow-ups in this native thread. Report the result, checks and any remaining blocker.',
 ];
 return `${context.filter(Boolean).join('\n\n')}\n\nUSER REQUEST:\n${task}`;
}
