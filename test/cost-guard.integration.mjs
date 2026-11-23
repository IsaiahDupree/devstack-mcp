import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = process.env.DEVSTACK_API_ROOT;
if (!apiRoot) throw new Error('Set DEVSTACK_API_ROOT to the real local DevStack API checkout.');
const api = path.join(path.resolve(apiRoot), 'server.js');
const token = randomBytes(32).toString('hex'), upstreamSecret = randomBytes(32).toString('hex');
const children = [];
const baseEnv = { PATH: process.env.PATH, NODE_ENV: 'test' };
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const p=server.address().port; await new Promise(r=>server.close(r)); return p;
}
function start(args, env, cwd, denyEgress = false) {
  const executable=denyEgress ? '/usr/bin/sandbox-exec' : process.execPath;
  const argv=denyEgress ? ['-p','(version 1)(allow default)(deny network-outbound)',process.execPath,...args] : args;
  const p=spawn(executable,argv,{cwd,env:{...baseEnv,...env},stdio:['ignore','pipe','pipe']});
  p.on('error',e=>process.stderr.write('child error '+e.message+'\n')); children.push(p); return p;
}
async function ready(p,url) {
  for(let i=0;i<80;i++) {
    if(p.exitCode!==null) throw new Error('local process exited early: '+p.exitCode);
    try { const r=await fetch(url,{signal:AbortSignal.timeout(250)}); if(r.ok) return; } catch {}
    await delay(100);
  }
  throw new Error('local service failed to start');
}
async function req(base, tokenValue, method='initialize', params={protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'local-cost-check',version:'1'}}) {
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream'};
  if(tokenValue) headers.authorization='Bearer '+tokenValue;
  const res=await fetch(base+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const body=await res.text();
  const data=body.startsWith('event:')||body.startsWith('data:') ? body.split('\n').find(x=>x.startsWith('data:'))?.slice(5).trim() : body;
  return {status:res.status, json:JSON.parse(data)};
}
try {
 const ap=await port();
 const realApi=start(['--input-type=module','-e',`import app from ${JSON.stringify(pathToFileURL(api).href)};app.listen(${ap},'127.0.0.1');`],{RAPIDAPI_PROXY_SECRET:upstreamSecret},path.resolve(apiRoot),true);
 const apiBase=`http://127.0.0.1:${ap}`; await ready(realApi,apiBase+'/api/health');
 const blockedDirect=await fetch(apiBase+'/v1/package?registry=npm&name=local-test'); assert.equal(blockedDirect.status,403);
 async function mcp(env={}) {
   const p=await port(), proc=start(['local-server.js'],{PORT:String(p),...env},root), base=`http://127.0.0.1:${p}`;
   await ready(proc,base+'/health'); return base;
 }
 const noAuth=await mcp(); assert.equal((await req(noAuth,token)).status,503);
 const defaultOff=await mcp({DEVSTACK_MCP_CLIENT_TOKEN:token});
 assert.equal((await req(defaultOff)).status,401);assert.equal((await req(defaultOff,'incorrect')).status,401);
 assert.equal((await req(defaultOff,token)).status,200);
 const list=await req(defaultOff,token,'tools/list',{}); assert.deepEqual(list.json.result.tools.map(x=>x.name).sort(),['get_dependency_graph','get_downloads','get_ecosystems_package','get_insights','get_package','get_versions','get_vulnerabilities','scan_vulnerabilities_batch','search_ecosystems','search_packages']);
 const callParams={name:'get_package',arguments:{registry:'npm',name:'local-test'}};
 const disabled=await req(defaultOff,token,'tools/call',callParams); assert.equal(disabled.json.result.isError,true); assert.match(disabled.json.result.content[0].text,/disabled by the operator/);
 const remote=await mcp({DEVSTACK_MCP_CLIENT_TOKEN:token,DEVSTACK_MCP_ALLOWED_TOOLS:'get_package,scan_vulnerabilities_batch',DEVSTACK_MCP_API_BASE_URL:'https://devstack-api.vercel.app'});
 const remoteCall=await req(remote,token,'tools/call',callParams);assert.equal(remoteCall.json.result.isError,true);assert.match(remoteCall.json.result.content[0].text,/remote_upstream_disabled/);
 const local=await mcp({DEVSTACK_MCP_CLIENT_TOKEN:token,DEVSTACK_MCP_ALLOWED_TOOLS:'get_package,scan_vulnerabilities_batch',DEVSTACK_MCP_API_BASE_URL:apiBase,DEVSTACK_MCP_PROXY_SECRET:upstreamSecret});
 const firstCall=await req(local,token,'tools/call',callParams); assert.equal(firstCall.json.result.isError,true);
 const localCall=await req(local,token,'tools/call',callParams);assert.equal(localCall.json.result.isError,true);assert.match(localCall.json.result.content[0].text, /Registry requests are disabled by the operator/i);
 const batch=await req(local,token,'tools/call',{name:'scan_vulnerabilities_batch',arguments:{queries:[{ecosystem:'npm',name:'local-test'}]}});assert.equal(batch.json.result.isError,true);assert.match(batch.json.result.content[0].text,/Registry requests are disabled by the operator/i);
 console.log('PASS: real local API + MCP HTTP: fail-closed auth and tool defaults, remote blocked, tool discovery, local authenticated forwarding returns the expected real API guard errors for GET and POST');
} finally {
 for(const p of children) if(p.exitCode===null) p.kill('SIGTERM');
 await Promise.all(children.map(p=>p.exitCode!==null?Promise.resolve():new Promise(resolve=>{p.once('exit',resolve);setTimeout(resolve,2000).unref();})));
}
