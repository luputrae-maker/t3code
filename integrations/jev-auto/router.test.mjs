import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateTargets, userRequest, workBrief, isNotice, settled} from './router.mjs';
import * as router from './router.mjs';

test('only ready native subscription models enter the classifier pool', () => {
  const config={profiles:[{id:'sol',provider:'codex',model:'sol',options:[],description:'Coding'}, {id:'go',provider:'opencode',model:'opencode-go/luna',options:[],description:'Coding'}, {id:'paid',provider:'opencode',model:'openrouter/paid',options:[],description:'No'}]};
  const providers=[{providerInstanceId:'codex',canRunChildTask:true,models:[{id:'sol'}]},{providerInstanceId:'opencode',canRunChildTask:true,models:[{id:'opencode-go/luna'},{id:'openrouter/paid'}]}];
  const ready={codex:{enabled:true,status:'ready',auth:{status:'authenticated',type:'chatgpt'}},opencode:{enabled:true,status:'ready',auth:{status:'authenticated'}}};
  assert.deepEqual(candidateTargets(config,{providers},ready).map(x=>x.id),['sol','go']);
  ready.codex.auth.status='unauthenticated';
  assert.deepEqual(candidateTargets(config,{providers},ready).map(x=>x.id),['go']);
});
test('native envelopes preserve the user request and wakeups never become new work',()=>{
 assert.equal(userRequest('<t3_code_instructions>host</t3_code_instructions><user_request>fix it</user_request>'),'fix it');
 assert.equal(userRequest('Context handoff (full_thread_summary):\nPrevious work.\n\nUser message:\n/jev-status'),'/jev-status');
 assert.equal(isNotice('Delegated task abc [completed]:\ndone'),true);
 assert.equal(isNotice('Please fix delegated tasks in my app'),false);
});
test('worker brief preserves planning limits and repository instructions',()=>{
 const b=workBrief('Plan only; no edits',{provider:'codex',model:'sol'},{interactionMode:'plan'},'/fixture');
 assert.match(b,/Plan only; no edits/);assert.match(b,/planning-only/);assert.match(b,/Read the repository instructions/);assert.match(b,/Do not call AI Router/);
});
test('completion needs all child work and approvals settled',()=>{
 const r={status:'completed',workState:'result_available',hasPendingChildRuns:false,hasPendingQuestion:false,pendingApproval:null};
 assert.equal(settled(r),true);assert.equal(settled({...r,hasPendingQuestion:true}),false);assert.equal(settled({...r,status:'running'}),false);
});

test('configured models omitted from T3 short lists are discovered before classification',async()=>{
 const config={profiles:[{id:'kimi',provider:'opencode',model:'opencode-go/kimi-k3.1-pro'}]};
 const statuses={opencode:{enabled:true,status:'ready',auth:{status:'authenticated'}}};
 const call=async(name,args)=>({parentThreadId:'parent',interactionMode:'default',providers:[{
  providerInstanceId:'opencode',canRunChildTask:true,models:args.search?[{id:'opencode-go/kimi-k3.1-pro'}]:[{id:'opencode-go/glm-5.3'}],omittedModels:1,
 }]});
 const result=await (router.availablePool??(async()=>({candidates:[]})))(config,statuses,call);
 assert.deepEqual(result.candidates.map(p=>p.id),['kimi']);
});

test('live account catalogs expose exact native models while preserving connection and quota restrictions', async () => {
 const config = {
  profiles: [{id:'sol',provider:'codex',model:'gpt-6.1-sol',options:[{id:'reasoningEffort',value:'medium'}]}],
  providerPauseUntil: {cursor:'2026-11-20T06:24:00Z'},
 };
 const account = (type, models) => ({
  enabled:true,status:'ready',auth:{status:'authenticated',type},
  models:models.map(model => typeof model === 'string' ? {slug:model,name:model} : model),
 });
 const statuses = {
  codex: account('chatgpt',['gpt-6.1-sol','gpt-6-luna']),
  claudeAgent: account('api-key',['claude-opus-5-5']),
  cursor: account('browser',['default','composer-2.5','grok-4.7','claude-opus-5-5']),
  antigravity: account('oauth-personal',['gemini-fast','gemini-pro',{slug:'custom',isCustom:true}]),
  opencode: account(undefined,['opencode-go/gpt-6-luna','opencode-go/hy4','openrouter/paid']),
 };
 const providers = Object.entries(statuses).map(([providerInstanceId,status]) => ({
  providerInstanceId, canRunChildTask:true, models:[{id:status.models[0].slug}], omittedModels:status.models.length - 1,
 }));
 const call = async () => ({parentThreadId:'test',providers});
 const before = await router.availablePool(config,statuses,call,{now:Date.parse('2026-11-18T18:00:00Z')});
 assert.deepEqual(before.candidates.map(p=>p.model), [
  'gpt-6.1-sol','gpt-6-luna','gemini-fast','gemini-pro','opencode-go/gpt-6-luna','opencode-go/hy4',
 ]);
 assert.deepEqual(before.candidates[0].options, config.profiles[0].options);
 const postReset = {
  now:Date.parse('2026-11-20T07:00:00Z'), hiddenModels:{cursor:['composer-2.5']},
 };
 const after = await router.availablePool(config,statuses,call,postReset);
 assert.deepEqual(after.candidates.filter(p=>p.provider==='cursor').map(p=>p.model), ['grok-4.7']);
 const prepaid = await router.availablePool({...config,cursorAllowThirdParty:true},statuses,call,postReset);
 assert.deepEqual(prepaid.candidates.filter(p=>p.provider==='cursor').map(p=>p.model), ['grok-4.7','claude-opus-5-5']);
 statuses.antigravity.auth.type = 'api-key';
 statuses.cursor.usageLimits = {windows:[{label:'Overall',usedPercent:100,resetsAt:'2026-11-21T00:00:00Z'}]};
 providers.find(p=>p.providerInstanceId==='opencode').canRunChildTask = false;
 const restricted = await router.availablePool(config,statuses,call,{now:Date.parse('2026-11-20T07:00:00Z')});
 assert.deepEqual([...new Set(restricted.candidates.map(p=>p.provider))], ['codex']);
});

test('an exhausted account is skipped until its session or weekly quota resets', () => {
 const config = {profiles:[]};
 const capabilities = {providers:[{providerInstanceId:'claudeAgent',canRunChildTask:true,models:[]}]};
 const statuses = {claudeAgent:{
  enabled:true,status:'ready',auth:{status:'authenticated',type:'Claude Pro'},
  models:[{slug:'claude-sonnet-5-5'}],
  usageLimits:{windows:[{label:'Weekly',usedPercent:100,resetsAt:'2026-11-19T17:00:00Z'}]},
 }};
 assert.equal(candidateTargets(config,capabilities,statuses,{now:Date.parse('2026-11-19T16:59:59Z')}).length,0);
 assert.equal(candidateTargets(config,capabilities,statuses,{now:Date.parse('2026-11-19T17:00:00Z')}).length,1);
});

test('native effort uses catalog values, preserves service tiers and leaves models without effort alone', () => {
 const cases = [
  ['codex','chatgpt','sol','reasoningEffort',['low','medium','high','ultra'],'high','high'],
  ['claudeAgent','Claude Pro','opus','effort',['low','high','ultrathink'],'ultra','ultrathink'],
  ['cursor','browser','grok-4.7','reasoning_effort',['low','medium','high','xhigh'],'max','xhigh'],
  ['cursor','browser','grok-4.6','effort',['low','medium','high'],'low','low'],
  ['cursor','browser','composer-2.5','fastMode',[false,true],'high',undefined],
  ['opencode',undefined,'opencode-go/kimi','variant',['low','high','max'],'medium','low'],
  ['antigravity','oauth-personal','gemini','thinking_level',['low','medium','high'],'low','low'],
  ['claudeAgent','Claude Pro','haiku','thinking',[false,true],'high',true],
 ];
 for (const [provider,type,slug,id,values,requested,expected] of cases) {
  const descriptor = typeof values[0] === 'boolean'
   ? {id,type:'boolean'} : {id,type:'select',options:values.map(value=>({id:value}))};
  const options = [{id:'serviceTier',value:'default'}];
  if (provider === 'codex') options.push({id:'reasoningEffort',value:'medium'});
  const profile = {id:slug,provider,model:slug,options};
  const statuses = {[provider]:{enabled:true,status:'ready',auth:{status:'authenticated',type},
   models:[{slug,capabilities:{optionDescriptors:[descriptor]}}]}};
  const capabilities = {providers:[{providerInstanceId:provider,canRunChildTask:true,models:[]}]};
  const [candidate] = candidateTargets({profiles:[profile]},capabilities,statuses);
  const applied = router.applyEffort(candidate,requested);
  assert.equal(applied?.value,expected,slug);
  assert.equal(applied?.id,expected === undefined ? undefined : id,slug);
  assert.deepEqual(candidate.options,[{id:'serviceTier',value:'default'}],slug);
 }
});

test('models with a context-window choice run at the standard window so subscriptions never need usage credits',()=>{
 const config={profiles:[]};
 const status={claudeAgent:{enabled:true,status:'ready',auth:{status:'authenticated',type:'Claude Pro'},models:[
  {slug:'claude-opus-4-6',name:'Opus 4.6',capabilities:{optionDescriptors:[
   {id:'effort',type:'select',options:[{id:'medium'},{id:'high',isDefault:true}]},
   {id:'contextWindow',type:'select',options:[{id:'200k'},{id:'1m',isDefault:true}]}]}},
  {slug:'claude-sonnet-5-5',name:'Sonnet 5.5',capabilities:{optionDescriptors:[
   {id:'effort',type:'select',options:[{id:'medium'},{id:'high'}]}]}},
 ]}};
 const providers=[{providerInstanceId:'claudeAgent',canRunChildTask:true,models:[]}];
 const out=candidateTargets(config,{providers},status);
 assert.deepEqual(out.map(p=>p.model),['claude-opus-4-6','claude-sonnet-5-5']);
 assert.deepEqual(out[0].options,[{id:'contextWindow',value:'200k'}]);
 assert.deepEqual(out[1].options,[]);
 assert.deepEqual(router.standardContext({capabilities:{optionDescriptors:[{id:'contextWindow',options:[{id:'1m'},{id:'272k'}]}]}}),{id:'contextWindow',value:'272k'});
 assert.equal(router.standardContext({capabilities:{optionDescriptors:[{id:'contextWindow',options:[{id:'200k'}]}]}}),undefined);
});
