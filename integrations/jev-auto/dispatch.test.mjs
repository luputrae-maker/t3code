import test from 'node:test';
import assert from 'node:assert/strict';
import {submitWork, drainWork} from './dispatch.mjs';

const codex={id:'codex',provider:'codex',model:'gpt-6-luna',options:[],description:'Implementation'};
const claude={id:'claude',provider:'claudeAgent',model:'claude-sonnet-5-5',options:[],description:'Review'};
const selection=p=>({instanceId:p.provider,model:p.model,options:p.options});
function fixture({chosen=claude,busy=false,failConfigure=false}={}){
 const state={id:'test',cwd:'/fixture',route:{classifier:'jev-test',profile:codex},
  request:{id:'first',task:'Implement the checkout',startedAt:'2026-11-16T00:00:00Z'},
  task:{taskId:'old-task',childThreadId:'native-child',status:'completed',summary:'Implemented checkout; tests passed.'}};
 const calls=[],classified=[];
 let model=selection(codex);
 const io={skillsRoot:'/skills',threadId:'parent',checkpoint:()=>{},say:()=>{},
  busy,failConfigure,
  async pool(){return {capabilities:{parentThreadId:'parent',interactionMode:'default'},candidates:[codex,claude]};},
  async classify(task,candidates){classified.push({task,candidates});return {classifier:'jev-test',profile:chosen,confidence:.8,probabilities:{codex:.2,claude:.8}};},
  async call(name,args){
   calls.push({name,args});
   if(name==='t3_thread_read')return {thread:{threadId:'native-child',status:io.busy?'running':'completed',activeRunId:io.busy?'old-run':null,pendingRequestCount:0},recentRuns:[],items:[],hasMore:false,nextPosition:null};
   if(name==='t3_thread_configure'){
    if(!args.modelSelection)return {threadId:'native-child',modelSelection:model,runtimeMode:'auto',interactionMode:'default'};
    if(io.failConfigure)throw Error('native configuration failed');
    model=args.modelSelection;return {sequence:42};
   }
   if(name==='t3_thread_send')return {threadId:'native-child',taskId:'new-task',runId:'new-run',status:'running',delivery:'started',link:'t3-thread://native-child'};
   if(name==='delegate_task')return {taskId:'first-task',childThreadId:'first-child',status:'running',link:'t3-thread://first-child'};
   throw Error('Unexpected operation '+name);
  }};
 return {state,io,calls,classified};
}

test('a changed task is reclassified and switches the existing native thread without changing permissions',async()=>{
 const f=fixture();
 await submitWork(f.state,'Review the checkout UX and wording',f.io);
 assert.equal(f.classified.length,1);
 assert.match(f.classified[0].task,/Review the checkout UX and wording/);
 assert.match(f.classified[0].task,/Implemented checkout/);
 assert.deepEqual(f.calls.filter(x=>x.name==='t3_thread_configure'&&x.args.modelSelection).map(x=>x.args),[
  {threadId:'native-child',modelSelection:{instanceId:'claudeAgent',model:'claude-sonnet-5-5',options:[]}}
 ]);
 const sent=f.calls.find(x=>x.name==='t3_thread_send');
 assert.equal(sent.args.threadId,'native-child');
 assert.match(sent.args.message,/Review the checkout UX and wording/);
 assert.equal(sent.args.freshContext,undefined);
 assert.equal(sent.args.mode,'queue');
 assert.equal(f.calls.some(x=>x.name==='delegate_task'),false);
 assert.equal(f.state.route.profile.provider,'claudeAgent');
 assert.equal(f.state.task.taskId,'new-task');
 assert.equal(f.state.task.workState,'working');
 assert.equal(f.state.routeHistory.at(-1).previousProvider,'codex');
 assert.equal(f.state.uncertain,false);
});

test('a continuation is still evaluated even when Jev keeps the same model',async()=>{
 const f=fixture({chosen:codex});
 await submitWork(f.state,'Add another checkout regression test',f.io);
 assert.equal(f.classified.length,1);
 assert.equal(f.calls.some(x=>x.name==='t3_thread_configure'&&x.args.modelSelection),false);
 assert.equal(f.calls.filter(x=>x.name==='t3_thread_send').length,1);
 assert.equal(f.state.routeHistory.at(-1).changed,false);
});

test('Jev can change only the effort on a follow-up in the same native thread', async () => {
 const f = fixture();
 await submitWork(f.state,'Review the checkout',f.io);
 const profile = {...claude,effort:{id:'effort',values:['low','high']}};
 f.io.pool = async () => ({capabilities:{parentThreadId:'parent',interactionMode:'default'},candidates:[profile]});
 f.io.classify = async () => ({classifier:'jev-test',profile,effort:'high',confidence:.9});
 const messages = [];
 f.io.say = message => messages.push(message);
 f.state.task.workState = 'result_available';
 await submitWork(f.state,'Investigate the intermittent race deeply',f.io);
 const change = f.calls.filter(call => call.name==='t3_thread_configure' && call.args.modelSelection).at(-1);
 assert.deepEqual(change.args.modelSelection,{instanceId:'claudeAgent',model:'claude-sonnet-5-5',options:[{id:'effort',value:'high'}]});
 assert.equal(f.calls.filter(call=>call.name==='t3_thread_send').at(-1).args.threadId,'native-child');
 assert.deepEqual(f.state.routeHistory.at(-1).effort,{requested:'high',id:'effort',value:'high'});
 assert.match(messages.join(' '),/effort \*\*high\*\*/);
});

test('busy work queues the request durably and routes it once at the next idle boundary',async()=>{
 const f=fixture({busy:true});
 await submitWork(f.state,'Now review the UX',f.io);
 assert.equal(f.classified.length,0);
 assert.equal(f.state.pending.length,1);
 assert.equal(f.calls.some(x=>x.name==='t3_thread_send'||x.name==='task_cancel'),false);
 f.io.busy=false;
 await drainWork(f.state,f.io);
 assert.equal(f.classified.length,1);
 assert.equal(f.state.pending.length,0);
 assert.equal(f.calls.filter(x=>x.name==='t3_thread_send').length,1);
 await drainWork(f.state,f.io);
 assert.equal(f.calls.filter(x=>x.name==='t3_thread_send').length,1);
});

test('an unavailable classification result cannot change a native thread',async()=>{
 const f=fixture({chosen:{...claude,id:'unoffered',model:'unavailable'}});
 await assert.rejects(submitWork(f.state,'Review',f.io),/unavailable|unoffered/i);
 assert.equal(f.calls.some(x=>x.name==='t3_thread_send'||x.args.modelSelection),false);
 assert.equal(f.state.uncertain,false);
});

test('a failed native switch cannot silently send to the previous model or duplicate work',async()=>{
 const f=fixture({failConfigure:true});
 await assert.rejects(submitWork(f.state,'Review',f.io),/native configuration failed/);
 assert.equal(f.state.uncertain,true);
 assert.equal(f.calls.some(x=>x.name==='t3_thread_send'),false);
 await assert.rejects(submitWork(f.state,'Try again',f.io),/uncertain/i);
 assert.equal(f.classified.length,1);
});

test('stopping during classification prevents dispatch',async()=>{
 const f=fixture();
 f.io.classify=async()=>{f.state.cancelled=true;f.state.pending=[];return {classifier:'jev-test',profile:claude};};
 await submitWork(f.state,'Review',f.io);
 assert.equal(f.calls.some(x=>x.name==='t3_thread_send'||x.args.modelSelection),false);
 assert.equal(f.state.pending.length,0);
});

test('a new chat delegates once using the classified target and inherited interaction mode',async()=>{
 const f=fixture();f.state.task=null;f.state.route=null;f.state.request=null;
 await submitWork(f.state,'Review a new project',f.io);
 assert.equal(f.classified.length,1);
 const dispatched=f.calls.filter(x=>x.name==='delegate_task');
 assert.equal(dispatched.length,1);
 assert.deepEqual(dispatched[0].args.target,{providerInstanceId:'claudeAgent',model:'claude-sonnet-5-5',options:[]});
 assert.match(dispatched[0].args.task,/T3 workspace: "\/fixture"/);
 assert.equal(dispatched[0].args.interactionMode,'default');
 assert.equal(dispatched[0].args.runtimeMode,undefined);
 assert.equal(f.state.pending.length,0);
});

test('stop while a native send is in flight cancels the newly acknowledged task',async()=>{
 const f=fixture();
 const call=f.io.call;
 f.io.call=async(name,args)=>{
  if(name==='task_cancel'){f.calls.push({name,args});return {status:'cancelled'};}
  const result=await call(name,args);
  if(name==='t3_thread_send'){f.state.cancelled=true;f.state.pending=[];}
  return result;
 };
 await submitWork(f.state,'Review',f.io);
 assert.equal(f.calls.find(x=>x.name==='task_cancel')?.args.taskId,'new-task');
 assert.equal(f.state.request.phase,'stop-requested');
});

test('a completed turn with unfinished delegated work does not switch providers yet',async()=>{
 const f=fixture();
 f.state.task.workState='waiting_for_children';f.state.task.hasPendingChildRuns=true;
 await submitWork(f.state,'Review after all implementation finishes',f.io);
 assert.equal(f.classified.length,0);
 assert.equal(f.state.pending.length,1);
 assert.equal(f.calls.some(x=>x.name==='t3_thread_send'||x.args.modelSelection),false);
 f.state.task.workState='result_available';f.state.task.hasPendingChildRuns=false;
 await drainWork(f.state,f.io);
 assert.equal(f.classified.length,1);
 assert.equal(f.state.pending.length,0);
});
