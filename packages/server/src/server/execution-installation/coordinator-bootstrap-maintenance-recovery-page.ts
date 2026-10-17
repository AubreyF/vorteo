/** Standalone assets: no primary application imports, session or service worker. */
export const maintenanceRecoveryDocument = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vorteo recovery</title><script src="/recovery.js" defer></script></head>
<body><main><h1>Vorteo recovery</h1>
<p>Bookmark this page. It works independently of the main interface on this machine.</p>
<p>Basic health does not prove the main interface works. You can request a reviewed compatible coordinator rollback even when health is green.</p>
<form id="access"><label>Installation owner password <input id="password" type="password" autocomplete="current-password" required maxlength="4096"></label>
<button id="check" type="submit">Check maintenance status</button></form>
<button id="prepare" type="button" disabled>Prepare compatible coordinator rollback</button>
<p>Preparation creates a review and does not restart anything. Approval replaces the coordinator and briefly interrupts the main interface. Host and Dev agents and retained histories are preserved.</p>
<button id="lock" type="button">Lock recovery access</button>
<p id="result" role="status">Enter your existing installation password. No maintenance action will be started.</p>
<ul id="requests"></ul>
<p>Recorded maintenance status does not prove current application usability. An unverified outcome requires observation, not another dispatch.</p>
</main></body></html>`;

export const maintenanceRecoveryScript = `"use strict";
const form=document.getElementById("access");
const password=document.getElementById("password");
const button=document.getElementById("check");
const prepare=document.getElementById("prepare");
const result=document.getElementById("result");
const requests=document.getElementById("requests");
let active=null;
let generation=0;
let unlocked=false;
const attempted=new Set();
const flags={bootRecovery:true,compatibleRecovery:true,factoryRuntimeAdoption:true,sourceUpdateTooling:true,previewMonitor:true};
function controls(){
  button.disabled=Boolean(active);
  prepare.disabled=Boolean(active)||!unlocked;
  for(const item of requests.querySelectorAll("button"))item.disabled=Boolean(active)||item.dataset.attempted==="true";
}
function lock(){
  generation++;
  if(active)active.abort();
  active=null;
  unlocked=false;
  password.value="";
  requests.replaceChildren();
  controls();
  result.textContent="Recovery access locked. Submitted decisions may still be in progress. Unlock to inspect recorded status.";
}
function text(parent,tag,value){
  const node=document.createElement(tag);node.textContent=String(value);parent.append(node);return node;
}
function decisionButton(parent,request,decision,label){
  const key=request.id+":"+request.revision+":"+decision;
  const action=document.createElement("button");action.type="button";action.textContent=label;
  action.dataset.attempted=String(attempted.has(key));
  action.addEventListener("click",()=>{
    if(active||attempted.has(key))return;
    attempted.add(key);action.dataset.attempted="true";
    void run("Submitting this exact owner decision. A lost reply is not permission to submit it again...",{
      type:"installation.bootstrap.decide.request",requestId:crypto.randomUUID(),...flags,
      ownerPassword:password.value,
      input:{id:request.id,revision:request.revision,planSha256:request.planSha256,decision}
    },130000,"installation.bootstrap.decide.response");
  });
  parent.append(action);
}
function render(retained){
  requests.replaceChildren();
  for(const request of retained){
    if(!request||typeof request.id!=="string"||typeof request.revision!=="string"||typeof request.planSha256!=="string"||!request.plan)throw new Error("The retained review is incomplete. No decision was submitted.");
    const item=document.createElement("li");
    text(item,"h2","Coordinator: "+String(request.status));
    text(item,"p",request.reason);
    const stage=request.execution?.stage;
    if(stage)text(item,"p","Recorded stage: "+stage+". This is retained evidence, not a fresh application test.");
    else if(request.status==="approved")text(item,"p","Dispatch outcome unverified. Check status; do not submit approval again.");
    text(item,"p","Current reviewed source: "+String(request.plan.previous?.sourceCommit));
    text(item,"p","Target source: "+String(request.plan.candidate?.sourceCommit));
    const fallback=request.plan.compatibleRecovery||request.plan.previous;
    text(item,"p","If candidate startup fails, the reviewed fallback source is "+String(fallback?.sourceCommit)+". A fallback is never candidate success.");
    const details=document.createElement("details");text(details,"summary","Exact reviewed plan");
    text(details,"pre",JSON.stringify({id:request.id,revision:request.revision,planSha256:request.planSha256,plan:request.plan},null,2));item.append(details);
    const ownRollback=typeof request.reason==="string"&&request.reason.startsWith("Owner-requested compatible coordinator rollback.");
    if(request.status==="pending"&&!request.execution&&ownRollback)decisionButton(item,request,"approve","Approve exact coordinator rollback");
    if((request.status==="pending"||request.status==="approved")&&!request.execution)decisionButton(item,request,"cancel","Cancel exact request before claim");
    requests.append(item);
  }
}
async function run(pending,message,timeout,expectedType){
  if(active)return;
  const current=++generation;
  const controller=new AbortController();active=controller;controls();result.textContent=pending;
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch("/api/installation/maintenance/owner",{
      method:"POST",credentials:"omit",redirect:"error",cache:"no-store",
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+password.value},
      body:JSON.stringify(message),signal:controller.signal
    });
    if(current!==generation)return;
    if(response.status===401){password.value="";unlocked=false;requests.replaceChildren();throw new Error("Owner authentication failed.");}
    if(!response.ok)throw new Error("Maintenance controls are unavailable. Check retained status before trying another action.");
    const reply=await response.json();if(current!==generation)return;
    if(reply.type!==expectedType||reply.payload?.requestId!==message.requestId)throw new Error("The reply could not be matched to this action. Check retained status; do not repeat a decision.");
    if(reply.payload?.error)throw new Error(String(reply.payload.error));
    if(!Array.isArray(reply.payload?.requests))throw new Error("Retained maintenance state could not be verified. Do not repeat a decision.");
    render(reply.payload.requests);unlocked=true;
    result.textContent="Retained reviews checked. Preparation is not approval; approval is not verified completion. Check the recorded outcome before any further action.";
  }catch(error){
    if(current===generation)result.textContent=controller.signal.aborted
      ? "The reply timed out. Submitted work may still be running. Check retained status; do not repeat approval."
      : error.message;
  }finally{
    clearTimeout(timer);if(current===generation){active=null;controls();}
  }
}
document.getElementById("lock").addEventListener("click",lock);
window.addEventListener("pagehide",lock);
form.addEventListener("submit",event=>{
  event.preventDefault();
  void run("Checking retained maintenance status...",{
    type:"installation.bootstrap.list_requests.request",requestId:crypto.randomUUID(),...flags
  },10000,"installation.bootstrap.list_requests.response");
});
prepare.addEventListener("click",()=>{
  if(active||!unlocked)return;
  void run("Preparing the exact compatible coordinator rollback review. Nothing is approved or restarted by preparation...",{
    type:"installation.maintenance.rollback.prepare.request",requestId:crypto.randomUUID()
  },125000,"installation.maintenance.rollback.prepare.response");
});`;
