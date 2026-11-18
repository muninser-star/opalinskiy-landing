export class BotStore {
  constructor(db,now=()=>new Date()){this.db=db;this.now=now;}
  async query(q){const {data,error}=await q;if(error)throw new Error('storage');return data;}
  async profile(owner){return this.query(this.db.from('family_bot_profiles').select('*').eq('owner_id',owner).maybeSingle());}
  async profiles(){return this.query(this.db.from('family_bot_profiles').select('*').eq('active',true));}
  async saveSettings(owner,value){await this.query(this.db.from('family_bot_profiles').update({settings:value,updated_at:this.now().toISOString()}).eq('owner_id',owner));}
  async get(key){const row=await this.query(this.db.from('family_bot_kv').select('value,expires_at').eq('key',key).maybeSingle());return row&&Date.parse(row.expires_at)>+this.now()?row.value:null;}
  async set(key,value,seconds=86400){await this.query(this.db.from('family_bot_kv').upsert({key,value,expires_at:new Date(+this.now()+seconds*1000).toISOString(),updated_at:this.now().toISOString()}));}
  async remove(key){await this.query(this.db.from('family_bot_kv').delete().eq('key',key));}
  async claim(key,owner,kind,payload={},seconds=86400){return this.query(this.db.rpc('family_bot_claim',{p_key:key,p_owner:owner,p_kind:kind,p_payload:payload,p_seconds:seconds}));}
  async job(key){return this.query(this.db.from('family_bot_jobs').select('*').eq('key',key).maybeSingle());}
  async finish(key,state,payload={}){await this.query(this.db.from('family_bot_jobs').update({state,payload,updated_at:this.now().toISOString()}).eq('key',key));}
  async lease(key,seconds=70){return this.query(this.db.rpc('family_bot_lease',{p_key:key,p_seconds:seconds}));}
  async acquireLease(key,seconds=180){if(!await this.lease(key,seconds))return null;const token=crypto.randomUUID();await this.set('lease:'+key,{token},seconds);return token;}
  async releaseLease(key,token){await this.query(this.db.from('family_bot_kv').delete().eq('key','lease:'+key).contains('value',{token}));}
  async cleanup(){const at=this.now().toISOString();await this.query(this.db.from('family_bot_kv').delete().lt('expires_at',at));await this.query(this.db.from('family_bot_jobs').delete().lt('expires_at',at));
    const cut=new Date(+this.now()-86400000).toISOString();await this.query(this.db.from('family_bot_jobs').update({payload:{}}).lt('created_at',cut).neq('payload','{}'));}
}
