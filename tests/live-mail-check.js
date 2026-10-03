// Opt-in production smoke check. It sends no email and writes no mail rows.
// Provide {secret:"..."} on hidden terminal stdin; never use command arguments.
import { createHmac, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const raw = await new Promise(resolve => {
  let input=""; if(process.stdin.isTTY)process.stdin.setRawMode(true);
  process.stderr.write("Ready for hidden webhook-test JSON.\n");
  process.stdin.setEncoding("utf8");
  const onData=value=>{input+=value;if(/[\r\n]/.test(input)){if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.removeListener("data",onData);process.stdin.pause();resolve(input.trim());}};
  process.stdin.on("data",onData);process.stdin.resume();
});
const {secret}=JSON.parse(raw), origin="https://tannedbyffy.co.uk";
const id="msg_"+randomUUID(), timestamp=String(Math.floor(Date.now()/1000));
const payload=JSON.stringify({type:"email.sent",data:{email_id:randomUUID()}});
const signature=createHmac("sha256",Buffer.from(secret.replace(/^whsec_/,""),"base64")).update(id+"."+timestamp+"."+payload).digest("base64");
const outcomes=[];
async function check(name,path,init,expected){const response=await fetch(origin+path,{...init,redirect:"manual",signal:AbortSignal.timeout(30000)});outcomes.push({name,status:response.status,expected});await response.arrayBuffer();if(response.status!==expected)throw new Error(name+" failed with "+response.status);}
await check("public Site and automatic maintenance request","/",{},200);
await check("Mail requires approved device","/api/admin/v1/mail/unread",{},401);
await check("unsigned webhook rejected","/api/webhooks/resend",{method:"POST",body:payload,headers:{"Content-Type":"application/json"}},401);
await check("real signed webhook and migrated Mail database","/api/webhooks/resend",{method:"POST",body:payload,headers:{"Content-Type":"application/json","svix-id":id,"svix-timestamp":timestamp,"svix-signature":"v1,"+signature}},200);
await writeFile(new URL("../docs/mail-evidence/live-public.json",import.meta.url),JSON.stringify({time:new Date().toISOString(),outcomes,emails_sent:0,mail_rows_written:0},null,2)+"\n");
console.log(JSON.stringify({live_mail_checks:outcomes,emails_sent:0}));
