import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {availablePool,isNotice,nativeProviders,settled} from './router.mjs';
import {submitWork,drainWork} from './dispatch.mjs';
import {incomingTask} from './prompt.mjs';

const assert=(ok,message)=>{if(!ok)throw Error(message);};
const here=path.dirname(fileURLToPath(import.meta.url));
const version='1.3.0';
const config=JSON.parse(fs.readFileSync(process.env.JEV_T3_CONFIG,'utf8'));
const sessions=new Map(),bridges=new Map();
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const say=(id,text)=>emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:id,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
const statePath=id=>{assert(/^[a-f0-9-]{36}$/.test(id),'Invalid session');return path.join(config.stateDir,id+'.json');};
function save(s){fs.mkdirSync(config.stateDir,{recursive:true,mode:0o700});const target=statePath(s.id),tmp=target+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s),{mode:0o600,flag:'wx'});fs.renameSync(tmp,target);}
function read(id){const p=statePath(id),stat=fs.lstatSync(p);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&!(stat.mode&0o077),'Unsafe session state');return JSON.parse(fs.readFileSync(p,'utf8'));}
class NativeBridge{
 constructor(spec,policy){
  assert(spec?.name==='t3-code'&&spec.command===process.env.T3_ACP_MCP_NODE,'Native T3 bridge mismatch');
  assert(fs.realpathSync(spec.command)===policy.executable,'Unexpected T3 executable');
  const entry=process.env.T3_ACP_MCP_ENTRYPOINT;
  assert(entry===policy.entrypoint,'Unexpected T3 entrypoint');
  assert(JSON.stringify(spec.args)===JSON.stringify([entry,'acp-mcp-bridge']),'Unexpected T3 bridge arguments');
  assert(process.env.T3CODE_THREAD_ID&&process.env.T3_ACP_MCP_AUTHORIZATION,'Missing native thread authentication');
  const endpoint=new URL(process.env.T3_ACP_MCP_ENDPOINT);
  assert(endpoint.origin===policy.endpointOrigin&&endpoint.pathname==='/mcp','Unexpected T3 endpoint');
  for(const pair of spec.env??[])assert(pair.value===(pair.name==='ELECTRON_RUN_AS_NODE'?'1':process.env[pair.name]),'Native bridge environment mismatch');
  this.command=spec.command;this.entry=entry;
 }
 async init(){}
 async close(){}
 async call(name,args){
  assert(['orchestrator_capabilities','delegate_task','task_status','task_cancel','t3_thread_send','t3_thread_read','t3_thread_configure'].includes(name),'Unsupported native operation');
  const r=await new Promise((resolve,reject)=>{
   const child=spawn(this.command,[this.entry,'acp-mcp-call',name,JSON.stringify(args)],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});
   let out='';const timer=setTimeout(()=>child.kill('SIGTERM'),50000);
   child.stdout.on('data',x=>{out+=x;if(out.length>2097152)child.kill('SIGTERM');});child.stderr.resume();
   child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);try{assert(code===0,'Native T3 call failed: '+name);resolve(JSON.parse(out));}catch(e){reject(e);}});
  });
  assert(!r.isError,'T3 rejected '+name);
  const v=r.structuredContent??JSON.parse(r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
  assert(!v?.error,'T3 rejected '+name+': '+JSON.stringify(v?.error??''));return v;
 }
}
async function bridge(s){
 if(bridges.has(s.id))return bridges.get(s.id);
 const spec=s.injected?.find(x=>x.name==='t3-code');assert(spec,'T3 native bridge was not supplied');
 const b=new NativeBridge(spec,config.bridge);await b.init();bridges.set(s.id,b);return b;
}
function persisted(s){const {injected,...data}=s;return data;}
function checkpoint(s){save(persisted(s));}
function classify(task,candidates){
 return new Promise((resolve,reject)=>{
  const child=spawn(config.python,[path.join(here,'classify.py')],{
   env:{JEV_T3_CONFIG:process.env.JEV_T3_CONFIG,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe'],
  });
  let out='',err='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},45000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.stdout.on('data',x=>{out+=x;if(out.length>131072)child.kill('SIGTERM');});child.stderr.on('data',x=>{if(err.length<4096)err+=x;});
  child.on('close',code=>{clearTimeout(timer);try{assert(!timedOut,'Jev classification timed out; no coding task started.');const r=JSON.parse(out);assert(code===0&&!r.error,r.error??'Jev classification failed.');assert(candidates.some(x=>JSON.stringify(x)===JSON.stringify(r.profile)),'Jev returned an unavailable route');resolve(r);}catch(e){reject(e);}});
  child.stdin.end(JSON.stringify({task,candidates}));
 });
}
async function report(s,b){
 const result=await b.call('task_status',{taskId:s.task.taskId});s.task={...s.task,...result};checkpoint(s);
 if(settled(result)){
  s.lastResult={taskId:s.task.taskId,summary:result.summary??'Native task '+result.status+'.'};
  if(s.lastReportedTaskId!==s.task.taskId){say(s.id,`${s.lastResult.summary}\n\n${result.link??s.task.link??''}`);s.lastReportedTaskId=s.task.taskId;checkpoint(s);}
 }
 else if(result.hasPendingQuestion||result.pendingApproval)say(s.id,`The ${s.route.profile.provider} task needs your answer in its native T3 thread. ${result.link??s.task.link??''}`);
 else say(s.id,`${s.route.profile.provider} is working. ${result.link??s.task.link??''}`);
 return result;
}
function execution(s,b){
 return {
  threadId:process.env.T3CODE_THREAD_ID,
  checkpoint:()=>checkpoint(s),say:text=>say(s.id,text),call:(name,args)=>b.call(name,args),classify,
  pool:async()=>{
   const statuses={};
   for(const provider of nativeProviders){
    try{statuses[provider]=JSON.parse(fs.readFileSync(path.join(config.home,'caches',provider+'.json'),'utf8'));}catch{}
   }
   const settings=JSON.parse(fs.readFileSync(path.join(config.home,'userdata','settings.json'),'utf8'));
   const hiddenModels=Object.fromEntries(Object.entries(settings.providerModelPreferences??{})
    .map(([provider,preferences])=>[provider,preferences.hiddenModels]));
   return availablePool(config,statuses,(name,args)=>b.call(name,args),{hiddenModels});
  },
 };
}
async function handle(method,p={}){
 if(method==='initialize')return {protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true},mcpCapabilities:{}},agentInfo:{name:'Jev · TypeSafe Auto',version},authMethods:[]};
 if(method==='session/new'){
  const s={id:crypto.randomUUID(),cwd:fs.realpathSync(p.cwd),injected:p.mcpServers??[],task:null,route:null};sessions.set(s.id,s);
  return {sessionId:s.id,models:{currentModelId:'auto',availableModels:[{modelId:'auto',name:'Jev Auto',description:'Real TypeSafe Jev selects a native subscription coding agent'}]}};
 }
 if(method==='session/load'){
  const s=read(p.sessionId);assert(s.cwd===fs.realpathSync(p.cwd),'Session workspace changed');s.injected=p.mcpServers??[];sessions.set(s.id,s);return {};
 }
 const s=sessions.get(p.sessionId);assert(s,'Unknown session');
 if(method==='session/set_model'){assert(p.modelId==='auto','Select Jev Auto');return {};}
 const b=await bridge(s);
 if(method==='session/cancel'){
  s.cancelled=true;s.pending=[];checkpoint(s);
  if(s.task?.taskId){await b.call('task_cancel',{taskId:s.task.taskId,clientRequestId:crypto.randomUUID(),reason:'User stopped Jev'});say(s.id,'Stop requested for the native task.');}return {};
 }
 assert(method==='session/prompt','Unsupported ACP method');
 const task=incomingTask(p.prompt,config.home);const notice=isNotice(task);
 if(task==='/jev-status'){
  if(s.task?.taskId)await report(s,b);
  const {candidates}=await execution(s,b).pool();
  const counts=new Map();
  for(const {provider} of candidates)counts.set(provider,(counts.get(provider)??0)+1);
  const available=[...counts].map(([provider,count])=>`${provider}: ${count}`).join(', ');
  const withEffort=candidates.filter(profile=>profile.effort).length;
  say(s.id,`Jev ${version} · ${candidates.length} eligible native models${available?` (${available})`:''}. ${withEffort} support automatic reasoning effort. ${s.pending?.length??0} queued request(s).`);
  return {stopReason:'end_turn'};
 }
 if(notice){
  if(s.task?.taskId){const result=await report(s,b);if(settled(result))await drainWork(s,execution(s,b));}
  return {stopReason:'end_turn'};
 }
 await submitWork(s,task,execution(s,b));
 return {stopReason:s.cancelled?'cancelled':'end_turn'};
}
let serial=Promise.resolve();
readline.createInterface({input:process.stdin}).on('line',line=>{
 let msg;try{msg=JSON.parse(line);}catch{return;}
 if(!msg.method)return;
 const run=async()=>{try{const result=await handle(msg.method,msg.params);if(msg.id!==undefined)emit({jsonrpc:'2.0',id:msg.id,result});}catch(e){if(msg.id!==undefined)emit({jsonrpc:'2.0',id:msg.id,error:{code:-32000,message:String(e.message).slice(0,600)}});}};
 if(msg.method==='session/cancel')void run();else serial=serial.then(run);
}).on('close',()=>{void serial.finally(async()=>{await Promise.allSettled([...bridges.values()].map(b=>b.close()));process.exit(0);});});
