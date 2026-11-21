import crypto from 'node:crypto';
import {applyEffort,workBrief} from './router.mjs';

const terminal=new Set(['idle','completed','interrupted','failed','cancelled','rolled_back']);
const ensure=(condition,message)=>{if(!condition)throw Error(message);};
const selection=p=>({instanceId:p.provider,model:p.model,options:p.options??[]});
const sameSelection=(a,b)=>a.instanceId===b.instanceId&&a.model===b.model&&
 JSON.stringify([...(a.options??[])].sort((x,y)=>x.id.localeCompare(y.id)))===
 JSON.stringify([...(b.options??[])].sort((x,y)=>x.id.localeCompare(y.id)));
const bounded=(text,bytes)=>Buffer.from(String(text??'')).subarray(0,bytes).toString('utf8');

async function childIsBusy(s,io){
 if(!s.task?.childThreadId)return false;
 // A provider turn can finish before its own delegated children settle. Only
 // the native task completion callback authorizes the next provider handoff.
 if(s.task.hasPendingChildRuns||s.task.hasPendingQuestion||s.task.pendingApproval||
    (s.task.workState&&s.task.workState!=='result_available'))return true;
 const {thread}=await io.call('t3_thread_read',{
  threadId:s.task.childThreadId,view:'messages',limit:1,runLimit:1,maxCharsPerItem:1000,
 });
 ensure(thread.threadId===s.task.childThreadId,'Native child context mismatch');
 return !!thread.activeRunId||thread.pendingRequestCount>0||!terminal.has(thread.status);
}

function routingContext(s,task){
 // Older turns supply context, not a sticky provider preference. Native T3 owns
 // the full conversation transfer; this bounded extract is only for Jev's choice.
 const previous=(s.routeHistory??[]).slice(-4).map(x=>({task:bounded(x.task,1400),provider:x.provider,model:x.model}));
 if(!previous.length&&s.request?.task)previous.push({task:bounded(s.request.task,1400),provider:s.route?.profile.provider,model:s.route?.profile.model});
 return JSON.stringify({
  selectionPurpose:'Select the best suited available native provider and exact model for CURRENT_REQUEST. Honor an explicit request to use an eligible model. A model merely mentioned in the task is context. For scoped coding, routine fixes and tests, favor an adequate OpenCode Go model when you expect comparable results. For deep reasoning, visual or long-context work, choose for the needed capability. Earlier work is context only; reassess all eligible choices each turn.',
  CURRENT_REQUEST:bounded(task,44000),
  previousWork:previous,
  latestResult:bounded(s.lastResult?.summary??s.task?.summary,5000),
 });
}

export async function submitWork(s,task,io){
 ensure(!s.uncertain,'The previous dispatch has an uncertain outcome. Inspect its native thread before starting new work.');
 ensure(typeof task==='string'&&task.trim(),'Empty task');
 s.cancelled=false;s.pending??=[];
 s.pending.push({id:crypto.randomUUID(),task,queuedAt:new Date().toISOString()});
 io.checkpoint();
 return drainWork(s,io);
}

export async function drainWork(s,io){
 if(s.cancelled||!s.pending?.length)return;
 ensure(!s.uncertain,'The previous dispatch has an uncertain outcome. Inspect its native thread before starting new work.');
 if(await childIsBusy(s,io)){
  io.say(`Queued for Jev to reassess when the current task finishes. ${s.task.link??''}`);
  return;
 }
 const queued=s.pending[0],previous=s.route?.profile;
 const context=routingContext(s,queued.task);
 const {capabilities,candidates}=await io.pool();
 ensure(capabilities.parentThreadId===io.threadId,'Native parent context mismatch');
 ensure(candidates.length,'No signed-in native subscription provider is available. Open Settings → Providers.');
 if(s.cancelled)return;
 s.request={id:queued.id,task:queued.task,phase:'classifying',startedAt:new Date().toISOString(),candidates:candidates.map(p=>p.id)};
 io.checkpoint();
 io.say('Jev is choosing a model and reasoning effort for this request…\n\n');
 let route;
 try{
  route=await io.classify(context,candidates);
  ensure(candidates.some(p=>JSON.stringify(p)===JSON.stringify(route.profile)),'Jev returned an unavailable route');
 }catch(error){
  s.uncertain=false;s.request.phase='classification-failed';
  s.pending=s.pending.filter(p=>p.id!==queued.id);io.checkpoint();throw error;
 }
 if(s.cancelled){s.request.phase='cancelled-before-dispatch';io.checkpoint();return;}
 s.request.phase='classified';s.request.selection=route;io.checkpoint();
 // A user may have started the native chat directly while classification ran.
 if(await childIsBusy(s,io)){
  io.say(`The native thread became busy; this task stays queued for its next boundary. ${s.task.link??''}`);
  return;
 }
 const appliedEffort=applyEffort(route.profile,route.effort);
 const profile=appliedEffort
  ? {...route.profile,options:[...(route.profile.options??[]),appliedEffort]} : route.profile;
 const target=selection(profile);
 let current;
 if(s.task?.childThreadId){
  current=await io.call('t3_thread_configure',{threadId:s.task.childThreadId});
  ensure(current.threadId===s.task.childThreadId,'Native child configuration mismatch');
 }
 const changed=current?!sameSelection(current.modelSelection,target):false;
 if(s.cancelled)return;
 const sameModel=current?.modelSelection.instanceId===target.instanceId && current.modelSelection.model===target.model;
 const changeNote=changed
  ? (sameModel ? ' (updating settings in this thread)' : ' (switching models in this thread)') : '';
 const effortLabel=typeof appliedEffort?.value==='boolean'
  ? (appliedEffort.value ? 'thinking on' : 'thinking off') : appliedEffort?.value;
 io.say(`${route.classifier} selected **${profile.provider} / ${profile.model}**${appliedEffort?` with effort **${effortLabel}**`:''}${changeNote}.\n\n`);
 // From this point a lost native response is uncertain. Never retry dispatch
 // automatically or fall back to the old provider after a rejected switch.
 s.uncertain=true;s.request.phase='dispatching';io.checkpoint();
 const brief=workBrief(queued.task,profile,capabilities,s.cwd);
 let result;
 if(current){
  if(changed){
   await io.call('t3_thread_configure',{threadId:s.task.childThreadId,modelSelection:target});
   s.request.phase='configured';io.checkpoint();
  }
  if(s.cancelled){s.uncertain=false;s.request.phase='cancelled-before-send';io.checkpoint();return;}
  result=await io.call('t3_thread_send',{
   threadId:s.task.childThreadId,
   message:brief,
   mode:'queue',clientRequestId:queued.id,
  });
  s.task={...s.task,taskId:result.taskId??s.task.taskId,status:result.status,childRunId:result.runId,link:result.link??s.task.link,
   workState:'working',hasPendingChildRuns:false,hasPendingQuestion:false,pendingApproval:null};
 }else{
  result=await io.call('delegate_task',{
   task:brief,
   target:{providerInstanceId:target.instanceId,model:target.model,options:target.options},
   isolation:'shared',mode:'async',interactionMode:capabilities.interactionMode,
   clientRequestId:queued.id,title:queued.task.split('\n')[0].slice(0,100),
  });
  s.task=result;
 }
 s.routeHistory??=[];
 s.routeHistory.push({requestId:queued.id,task:queued.task,classifier:route.classifier,provider:profile.provider,model:profile.model,
  previousProvider:current?.modelSelection.instanceId??previous?.provider??null,changed,
  ...(appliedEffort?{effort:{requested:route.effort,...appliedEffort}}:{}),
  confidence:route.confidence,probabilities:route.probabilities,candidates:candidates.map(p=>p.id),
  childThreadId:s.task.childThreadId,runId:result.runId??result.childRunId,taskId:s.task.taskId,dispatchedAt:new Date().toISOString()});
 s.route=appliedEffort?{...route,profile,appliedEffort}:route;s.uncertain=false;s.request.phase='dispatched';
 s.pending=s.pending.filter(p=>p.id!==queued.id);io.checkpoint();
 if(s.cancelled){
  s.request.phase='stop-requested';s.request.stopRequestId=crypto.randomUUID();io.checkpoint();
  await io.call('task_cancel',{taskId:s.task.taskId,clientRequestId:s.request.stopRequestId,reason:'User stopped Jev while dispatch was in flight'});
  io.say(`Stop requested for the newly started native task. ${s.task.link??''}`);
  return;
 }
 io.say(`Started in T3. ${s.task.link??''}\n`);
}
