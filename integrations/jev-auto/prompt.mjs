import fs from 'node:fs';
import path from 'node:path';
import {userRequest} from './router.mjs';

export function incomingTask(blocks,home){
 if(!Array.isArray(blocks)||!blocks.every(x=>x?.type==='text'||x?.type==='image'))
  throw Error('Jev accepts text and image attachments only.');
 const text=userRequest(blocks.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
 const images=blocks.filter(x=>x.type==='image');
 if(images.length){
  const directory=fs.realpathSync(path.join(home,'userdata','attachments'))+path.sep;
  const listed=[...text.matchAll(/\[Attached image "[^"]+" is saved at: ([^\]\n]+)\]/g)].map(x=>x[1]);
  if(listed.length<images.length)throw Error('An attached image has no saved T3 path; Jev did not dispatch the task.');
  for(const file of listed){
   const resolved=fs.realpathSync(file);
   if(!resolved.startsWith(directory)||!fs.statSync(resolved).isFile())
    throw Error('An attached image path is outside T3 storage; Jev did not dispatch the task.');
  }
 }
 return text;
}
