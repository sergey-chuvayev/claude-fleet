'use strict'
const fs=require('node:fs')
const path=require('node:path')
const {randomUUID}=require('node:crypto')
const {stateDir}=require('./paths')
const fail=(message,status=400)=>Object.assign(new Error(message),{status})
class GatewaySettings {
  constructor({directory=stateDir(),env=process.env,fetchImpl=fetch}={}) {
    this.file=path.join(directory,'gateway-key.json');this.env=env;this.fetchImpl=fetchImpl
  }
  savedKey(){
    try{return JSON.parse(fs.readFileSync(this.file,'utf8')).apiKey || ''}
    catch(error){if(error.code==='ENOENT')return '';throw fail('Unable to read the saved AI Gateway key. Check Fleet storage permissions.',503)}
  }
  key(){return this.savedKey() || this.env.AI_GATEWAY_API_KEY || ''}
  status(){const saved=!!this.savedKey();return {configured:saved || !!this.env.AI_GATEWAY_API_KEY,source:saved ? 'saved':this.env.AI_GATEWAY_API_KEY ? 'environment':null}}
  save(apiKey){
    if(typeof apiKey!=='string' || !apiKey.trim() || apiKey.length>4096 || /\s/.test(apiKey.trim()))throw fail('Enter a valid AI Gateway API key.')
    const temp=this.file+'.'+randomUUID()+'.tmp'
    try{
      fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700})
      fs.writeFileSync(temp,JSON.stringify({apiKey:apiKey.trim()}),{mode:0o600,flag:'wx'})
      fs.renameSync(temp,this.file)
    }catch{throw fail('Unable to save the AI Gateway key. Check Fleet storage permissions.',503)}
    finally{try{fs.unlinkSync(temp)}catch{}}
    return this.status()
  }
  remove(){try{fs.unlinkSync(this.file)}catch(error){if(error.code!=='ENOENT')throw fail('Unable to remove the saved AI Gateway key.',503)}return this.status()}
  async test(){
    const key=this.key()
    if(!key)throw fail('Save an AI Gateway key first.')
    try{
      const response=await this.fetchImpl('https://ai-gateway.vercel.sh/v1/evaluate',{method:'POST',redirect:'error',signal:AbortSignal.timeout(4000),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'typesafe-ai/jev',state:{text:'Fleet connection test.'},questions:{connected:{type:'boolean',instructions:'Does the text mention Fleet?'}}})})
      if(!response.ok){await response.body?.cancel();return {ok:false,message:response.status===401 || response.status===403 ? 'AI Gateway rejected the key. Check its permissions or replace it.':response.status===402 ? 'AI Gateway requires credits. Check your Gateway billing.':'AI Gateway could not complete the test. Try again later.'}}
      const data=await response.json(),answer=data.answers?.connected
      if(answer?.type!=='boolean' || typeof answer.probability!=='number' || answer.probability<0 || answer.probability>1)return {ok:false,message:'Jev returned an unexpected response. Try again later.'}
      return {ok:true,message:'Connected. Jev is available for new Auto sessions.'}
    }catch{return {ok:false,message:'Could not reach AI Gateway. Check your connection and try again.'}}
  }
}
module.exports={GatewaySettings}
