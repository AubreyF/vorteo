/** Standalone assets: no primary application imports, session or service worker. */
export const maintenanceRecoveryDocument = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vorteo recovery</title><script src="/recovery.js" defer></script></head>
<body><main><h1>Vorteo recovery</h1>
<p>Bookmark this page. It works independently of the main interface on this machine.</p>
<p>Basic health does not prove the main interface works. Check the retained maintenance status below.</p>
<form id="access"><label>Installation owner password <input id="password" type="password" autocomplete="current-password" required maxlength="4096"></label>
<button id="check" type="submit">Check maintenance status</button></form>
<button id="lock" type="button">Lock recovery access</button>
<p id="result" role="status">Enter your existing installation password. No maintenance action will be started.</p>
<ul id="requests"></ul>
<p>This page currently shows retained coordinator reviews. Rollback controls require a separately reviewed compatible plan and are not available in this view.</p>
</main></body></html>`;

export const maintenanceRecoveryScript = `"use strict";
const form=document.getElementById("access");
const password=document.getElementById("password");
const button=document.getElementById("check");
const result=document.getElementById("result");
const requests=document.getElementById("requests");
let active=null;
let generation=0;
function lock(){
  generation++;
  if(active)active.abort();
  active=null;
  password.value="";
  requests.replaceChildren();
  button.disabled=false;
  result.textContent="Recovery access locked. No maintenance action was started.";
}
document.getElementById("lock").addEventListener("click",lock);
window.addEventListener("pagehide",lock);
form.addEventListener("submit",async(event)=>{
  event.preventDefault();
  if(active)return;
  const current=++generation;
  const controller=new AbortController();
  active=controller;
  button.disabled=true;
  requests.replaceChildren();
  result.textContent="Checking retained maintenance status...";
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch("/api/installation/maintenance/owner",{
      method:"POST",credentials:"omit",redirect:"error",cache:"no-store",
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+password.value},
      body:JSON.stringify({type:"installation.bootstrap.list_requests.request",requestId:crypto.randomUUID()}),
      signal:controller.signal
    });
    if(current!==generation)return;
    if(response.status===401){password.value="";throw new Error("Owner authentication failed.");}
    if(!response.ok)throw new Error("Maintenance inspection is unavailable. This does not prove service health or absence.");
    const reply=await response.json();
    if(current!==generation)return;
    if(reply.type!=="installation.bootstrap.list_requests.response" || reply.payload?.error || !Array.isArray(reply.payload?.requests))
      throw new Error("Retained maintenance state could not be verified. No action was started.");
    for(const request of reply.payload.requests){
      const item=document.createElement("li");
      item.textContent=String(request.reason)+": "+String(request.status);
      requests.append(item);
    }
    result.textContent="Retained reviews checked. This is not a full application health test. No maintenance action was started.";
  }catch(error){
    if(current===generation)result.textContent=controller.signal.aborted
      ? "Inspection timed out. Outcome remains unverified; no maintenance action was started."
      : error.message;
  }finally{
    clearTimeout(timer);
    if(current===generation){active=null;button.disabled=false;}
  }
});`;
