import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {incomingTask} from './prompt.mjs';

test('a T3 image prompt keeps the saved image path in the worker request',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'jev-image-'));
 const directory=path.join(home,'userdata','attachments');fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,'screen.jpg');fs.writeFileSync(file,'fixture');
 try{
  const task=incomingTask([{type:'text',text:`<user_request>Review cashier\n\n[Attached image "screen.jpg" is saved at: ${file}]</user_request>`},{type:'image',data:'Zml4dHVyZQ==',mimeType:'image/jpeg'}],home);
  assert.match(task,/Review cashier/);assert.match(task,/screen\.jpg/);
  assert.throws(()=>incomingTask([{type:'text',text:'Review cashier'},{type:'image',data:'Zml4dHVyZQ=='}],home),/no saved T3 path/);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
