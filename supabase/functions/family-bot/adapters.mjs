import {clean,oneLine,settings,clock,dayOffset,DASHBOARD_URL} from './core.mjs';
export class ExternalError extends Error{
  constructor(code,status=0,retryAfter=0){super(code);this.status=status;this.retryAfter=retryAfter;}
}
const BALANCES=new Set(['polza','proxy','usage','ycloud']);
const ACTIONS=new Set([...BALANCES,'sched_list']);
export class DashboardAPI{
  constructor({db,env,fetcher=fetch,now=()=>new Date()}){this.db=db;this.env=env;this.fetch=fetcher;this.now=now;}
  async access(profile){
    if(!profile?.active||String(profile.owner_id)!==String(this.env('FAMILY_BOT_OWNER_ID'))||String(profile.chat_id)!==String(profile.owner_id))throw new ExternalError('forbidden');
    const {data:code,error}=await this.db.from('access_codes').select('id,owner,revoked_at').eq('id',profile.code_id).maybeSingle();
    if(error)throw new ExternalError('source_unavailable');
    if(!code||code.revoked_at||code.owner!=='denis')throw new ExternalError('forbidden');
    return {profile,code};
  }
  async json(url,init={}){
    let response,body;
    try{response=await this.fetch(url,{...init,signal:AbortSignal.timeout(15000)});body=await response.json();}
    catch{throw new ExternalError('source_unavailable');}
    if(!response.ok)throw new ExternalError(oneLine(body?.code,80)||'source_unavailable',response.status);
    return body;
  }
  async call(action,payload={}){
    if(!ACTIONS.has(action))throw new ExternalError('unsupported_action');
    const key=this.env('FAMILY_BOT_SOURCE_KEY');
    if(!key)throw new ExternalError('source_not_connected');
    const data=await this.json(this.env('SUPABASE_URL')+'/functions/v1/dash',{method:'POST',headers:{'Content-Type':'application/json','x-mk-key':key},body:JSON.stringify({...payload,action})});
    if(data.status!=='ok')throw new ExternalError('source_unavailable');
    return data;
  }
  async school(from,to){
    const key=this.env('FAMILY_BOT_SOURCE_KEY');
    if(!key)throw new ExternalError('source_not_connected');
    const data=await this.json(this.env('SUPABASE_URL')+'/functions/v1/school',{method:'POST',headers:{'Content-Type':'application/json','x-mk-key':key},body:JSON.stringify({action:'list',from,to})});
    if(data.status!=='ok'||!Array.isArray(data.events))throw new ExternalError('source_unavailable');
    return data.events;
  }
  async eventSnapshot(now){
    const day=clock(now).day;
    const [school,calendar]=await Promise.allSettled([
      this.school(day,dayOffset(day,1)),
      this.call('sched_list',{from:new Date(+now-3*3600000).toISOString(),to:new Date(+now+50*3600000).toISOString()}),
    ]);
    if(school.status==='rejected'&&calendar.status==='rejected')return {state:'unavailable'};
    const rows=school.status==='fulfilled'?school.value:[];
    const legacy=calendar.status==='fulfilled'?(calendar.value.events||[]).filter(e=>
      e.child!=='denis'&&!/^(?:офис[\s.!]*$|денис[\s.,:·–—-])/iu.test(String(e.title).trim())):[];
    const eventKey=e=>{
      const title=String(e.title||'').toLowerCase().trim();
      const name=title.match(/^(дима|даня|аня|анна)[\s.,:·–—-]+/u);
      const child=e.child||({дима:'dima',даня:'danya',аня:'anya',анна:'anya'}[name?.[1]]||'family');
      return [child,Date.parse(e.start),name?title.slice(name[0].length):title].join('|');
    };
    const keys=new Set(rows.map(eventKey));
    return {state:'ok',data:{events:[...rows,...legacy.filter(e=>!keys.has(eventKey(e)))],
      schoolUnavailable:school.status==='rejected',calendarUnavailable:calendar.status==='rejected'}};
  }
  async snapshot(context,options={}){
    await this.access(context.profile);
    const cfg=settings({...context.profile.settings,...options}),selected=new Set(cfg.sections);
    let tiles=[],configError=false;
    if(cfg.sections.some(x=>x!=='events'))try{
      const config=await this.json(DASHBOARD_URL+encodeURIComponent('плашки.json'),{cache:'no-store'});
      if(!Array.isArray(config))throw Error('bad_config');
      const seen=new Set();
      tiles=config.filter(t=>t&&t.url&&BALANCES.has(t.balance)&&selected.has(t.balance)&&!seen.has(t.balance)&&seen.add(t.balance))
        .map(t=>({kind:t.balance,title:oneLine(t.title,60)}));
    }catch{configError=true;}
    const now=this.now();
    const [results,events]=await Promise.all([
      Promise.allSettled(tiles.map(t=>this.call(t.kind))),
      selected.has('events')?this.eventSnapshot(now):{state:'not_selected'},
    ]);
    const status=r=>r.status==='fulfilled'?{state:'ok',data:r.value}:{state:'unavailable'};
    tiles=tiles.map((t,i)=>({...t,result:status(results[i])}));
    return {tiles,configError,events,readAt:this.now().toISOString()};
  }
}
export class TelegramAPI{
  constructor(token,fetcher=fetch){this.token=token;this.fetch=fetcher;}
  async call(method,body){
    let response,data;
    try{response=await this.fetch('https://api.telegram.org/bot'+this.token+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});data=await response.json();}
    catch{throw new ExternalError('delivery_unknown');}
    if(method==='editMessageText'&&data.description?.includes('message is not modified'))return {message_id:body.message_id};
    if(!response.ok||!data.ok)throw new ExternalError(data.error_code===403?'blocked':data.error_code===429?'limited':'telegram_rejected',data.error_code||response.status,data.parameters?.retry_after||0);
    return data.result;
  }
  send(chat,text,keyboard){return this.call('sendMessage',{chat_id:chat,text:clean(text,4000),link_preview_options:{is_disabled:true},...(keyboard?{reply_markup:{inline_keyboard:keyboard}}:{})});}
  callback(id){return this.call('answerCallbackQuery',{callback_query_id:id});}
  edit(chat,messageId,text,keyboard){return this.call('editMessageText',{chat_id:chat,message_id:messageId,text:clean(text,4000),link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:keyboard}});}
}
