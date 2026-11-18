import {clock,dayOffset,settings,dueSlot,summary,eventsText,schoolText,paginate,DASHBOARD_URL,SECTIONS,SECTION_IDS} from './core.mjs';
import {polzaAmount,proxyAlerts,POLZA_THRESHOLD} from './alerts.mjs';
const DAY_NAMES=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const ERRORS={
  quiet_time:'Время обычной сводки выбирай с 07:00 до 22:59 МСК. Срочные сигналы работают круглосуточно.',
  bad_time:'Напиши время в формате 08:30. Для нескольких отправок: 08:30, 18:00.',
  bad_times:'Можно выбрать не больше шести времён отправки.',
  bad_settings:'Не получилось сохранить этот выбор. Открой настройки заново.',
  busy:'Настройки ещё сохраняются. Повтори нажатие через пару секунд.',
  forbidden:'Доступ к дашборду сейчас отключён.',
  source_unavailable:'Дашборд сейчас недоступен. Попробуй обновить сводку позже.'
};
const SECTION_BUTTONS = {
  polza: '💰 Баланс Polza',
  events: '📅 События',
  proxy: '🌐 Срок прокси',
  usage: '🗄 Supabase',
  ycloud: '☁️ Yandex Cloud',
};
const TIME_PRESETS = ['07:30', '09:00', '12:00', '18:00', '21:00'];
const button = (text, callback_data) => ({ text, callback_data });
const mark = (label, selected) => label + (selected ? ' ✓' : '');
const back = (screen = 'home') => [button('← Назад', 'settings:' + screen)];

function settingsScreen(screen, cfg) {
  switch (screen) {
    case 'content': {
      const sections = SECTIONS.map(({ id, label }) =>
        button(mark(SECTION_BUTTONS[id] ?? label, cfg.sections.includes(id)), 'section:' + id));
      return {
        text: '📋 Состав сводки\n\n' + (cfg.sections.length
          ? 'Отметь блоки, которые хочешь получать. ✓ означает, что блок выбран.'
          : 'Выбери хотя бы один блок, чтобы получать сводку.'),
        keyboard: [sections.slice(0, 2), sections.slice(2, 4), sections.slice(4),
          [button('Все блоки', 'sections:all'), button('Снять выбор', 'sections:none')], back()],
      };
    }
    case 'schedule': {
      const days = cfg.days.length === 7 ? 'Каждый день' : cfg.days.map(day => DAY_NAMES[day - 1]).join(', ');
      const times = cfg.times.length ? cfg.times.join(', ') + ' МСК' : 'Время не выбрано';
      return {
        text: '🗓 Расписание сводки\n\n' + (days || 'Дни не выбраны') + '\n' + times,
        keyboard: [[button('📅 Дни недели', 'settings:days')], [button('🕒 Время отправки', 'settings:times')], back()],
      };
    }
    case 'days': {
      const days = DAY_NAMES.map((label, i) => button(mark(label, cfg.days.includes(i + 1)), 'day:' + (i + 1)));
      return {
        text: '📅 Дни недели\n\n' + (cfg.days.length
          ? 'Отметь дни, когда нужна сводка.'
          : 'Выбери хотя бы один день, чтобы получать сводку.'),
        keyboard: [days.slice(0, 4), days.slice(4),
          [button('Все дни', 'days:all'), button('Будни', 'days:weekdays'), button('Выходные', 'days:weekend')],
          back('schedule')],
      };
    }
    case 'times': {
      const choices = [...new Set([...TIME_PRESETS, ...cfg.times])].sort();
      const rows = [];
      for (let i = 0; i < choices.length; i += 3) {
        rows.push(choices.slice(i, i + 3).map(time => button(mark(time, cfg.times.includes(time)), 'toggleTime:' + time)));
      }
      return {
        text: '🕒 Время сводки\n\nВыбери одно или несколько времён с 07:00 до 22:59 по Москве.',
        keyboard: [...rows, [button('✏️ Ввести своё время', 'customTimes')], back('schedule')],
      };
    }
    case 'alerts':
      return {
        text: '🔔 Срочные уведомления\n\nРаботают круглосуточно. Выбери сигналы и частоту проверки.',
        keyboard: [
          [button(mark('💰 Polza ниже 70 ₽', cfg.alerts.polza), 'alert:polza')],
          [button(mark('🌐 Прокси за 3 и 1 день', cfg.alerts.proxy), 'alert:proxy')],
          [15, 30].map(minutes => button(mark('⏱ ' + minutes + ' мин', cfg.monitorMinutes === minutes), 'monitor:' + minutes)),
          back(),
        ],
      };
    default:
      return {
        text: '⚙️ Настройки\n\n' + (cfg.paused ? 'Все отправки на паузе.' : 'Выбери раздел.'),
        keyboard: [
          [button('📋 Состав сводки', 'settings:content')],
          [button('🗓 Расписание', 'settings:schedule')],
          [button('🔔 Срочные уведомления', 'settings:alerts')],
          [button(cfg.paused ? '▶️ Возобновить отправку' : '⏸ Пауза всех отправок', cfg.paused ? 'resume' : 'pause')],
        ],
      };
  }
}

export class BotEngine{
  constructor({store,dashboard,telegram,env,now=()=>new Date()}){Object.assign(this,{store,dashboard,telegram,env,now});}
  keyboard(more=false){
    return [
      ...(more ? [[button('📅 Все события', 'events')]] : []),
      [button('🔄 Обновить сводку', 'summary'), button('⚙️ Настройки', 'settings:open')],
      [button('Школа и кружки', 'school')],
      [{ text: '↗ Открыть дашборд', url: DASHBOARD_URL }],
    ];
  }
  async privateProfile(sender,chat){
    if(chat?.type!=='private'||String(sender?.id)!==String(chat.id)||String(sender?.id)!==String(this.env('FAMILY_BOT_OWNER_ID')))return null;
    const profile=await this.store.profile(sender.id);
    return profile?.active&&String(profile.chat_id)===String(chat.id)?profile:null;
  }
  async update(update){
    const callback=update?.callback_query,message=update?.message||callback?.message;
    if(!message)return {ignored:true};
    const profile=await this.privateProfile(callback?.from||message.from,message.chat);
    if(!profile)return {ignored:true};
    const key='update:'+profile.owner_id+':'+update.update_id;
    if(!await this.store.claim(key,profile.owner_id,'update',{},86400*90))return {duplicate:true};
    if(callback)try{await this.telegram.callback(callback.id);}catch{}
    try{
      await this.dashboard.access(profile);
      if(callback)await this.routeCallback(profile,String(callback.data||''),message.message_id);
      else await this.routeMessage(profile,String(message.text||'').trim());
      await this.store.finish(key,'done');return {ok:true};
    }catch(error){
      if(error.message==='delivery_unknown'){await this.store.finish(key,'unknown');return {accepted:true};}
      try{await this.telegram.send(profile.chat_id,ERRORS[error.message]||ERRORS.source_unavailable,this.keyboard());await this.store.finish(key,'error');}
      catch{await this.store.finish(key,'unknown');}
      return {accepted:true};
    }
  }
  async fresh(profile){
    const fresh=await this.store.profile(profile.owner_id),context=await this.dashboard.access(fresh);
    return {profile:fresh,context};
  }
  async showSummary(profile){
    const {context}=await this.fresh(profile),cfg=settings(context.profile.settings);
    const snapshot=await this.dashboard.snapshot(context);
    const {profile:fresh}=await this.fresh(profile);
    if(JSON.stringify(cfg)!==JSON.stringify(settings(fresh.settings)))return this.telegram.send(fresh.chat_id,'Настройки изменились. Обнови сводку ещё раз.',this.keyboard());
    const result=summary(snapshot,this.now(),cfg);
    return this.telegram.send(fresh.chat_id,result.text,this.keyboard(result.remaining>0));
  }
  async showEvents(profile){
    const {context}=await this.fresh(profile),snapshot=await this.dashboard.snapshot(context,{sections:['events']});
    await this.fresh(profile);return this.paged(profile,eventsText(snapshot,this.now(),{all:true}).text);
  }
  async showSchool(profile,child){
    await this.fresh(profile);
    const from=clock(this.now()).day,to=dayOffset(from,6);
    const rows=await this.dashboard.school(from,to);
    await this.fresh(profile);
    return this.paged(profile,schoolText(rows,from,to,child));
  }
  async paged(profile,text){
    const pages=paginate(text);
    if(pages.length===1)return this.telegram.send(profile.chat_id,pages[0],this.keyboard());
    const id=crypto.randomUUID().replaceAll('-','').slice(0,24);
    await this.store.set('dashboard:pages:'+profile.owner_id+':'+id,{pages},900);
    return this.telegram.send(profile.chat_id,pages[0],[[{text:'Дальше',callback_data:'page:'+id+':1'}],...this.keyboard()]);
  }
  async settingsReply(profile,text,keyboard,messageId){
    if(messageId&&this.telegram.edit)return this.telegram.edit(profile.chat_id,messageId,text,keyboard);
    return this.telegram.send(profile.chat_id,text,keyboard);
  }
  async showSettings(profile, messageId, screen = 'home') {
    const {profile:fresh}=await this.fresh(profile);
    await this.store.remove('dashboard:settingsInput:'+profile.owner_id);
    const {text,keyboard}=settingsScreen(screen,settings(fresh.settings));
    return this.settingsReply(fresh,text,keyboard,messageId);
  }
  async changeSettings(profile,change,messageId,screen){
    const key='dashboard:settings:'+profile.owner_id,token=await this.store.acquireLease(key,30);
    if(!token)throw Error('busy');
    try{
      const {profile:fresh}=await this.fresh(profile),cfg=settings(fresh.settings);
      await this.store.saveSettings(fresh.owner_id,settings(change(cfg)));
    }finally{await this.store.releaseLease(key,token);}
    return this.showSettings(profile,messageId,screen);
  }
  async setTime(profile,input,messageId){
    const times=String(input).split(/[,;\s]+/).filter(Boolean);
    if(!times.length)throw Error('bad_time');
    return this.changeSettings(profile,cfg=>({...cfg,times}),messageId,'times');
  }
  async setPaused(profile,paused,messageId){return this.changeSettings(profile,cfg=>({...cfg,paused}),messageId);}
  async routeMessage(profile,text){
    const m=text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/u),command=m?.[1]?.toLowerCase();
    if(!command&&await this.store.get('dashboard:settingsInput:'+profile.owner_id))return this.setTime(profile,text);
    if(['start','summary','today'].includes(command)||/^(сводка|дашборд|обновить|баланс|прокси|события|polza|польза)[?!.\s]*$/iu.test(text))return this.showSummary(profile);
    if(command==='events')return this.showEvents(profile);
    if(command==='school'){
      const who=(m[2]||'').trim().toLowerCase(),child=new Map([['дима','dima'],['даня','danya'],['аня','anya'],['dima','dima'],['danya','danya'],['anya','anya']]).get(who);
      if(who&&!child)return this.telegram.send(profile.chat_id,'Команды: /school, /school Дима, /school Даня или /school Аня.',this.keyboard());
      return this.showSchool(profile,child);
    }
    if(command==='settings'||command==='cancel')return this.showSettings(profile);
    if(command==='time')return this.setTime(profile,(m[2]||'').trim());
    if(command==='pause'||command==='resume')return this.setPaused(profile,command==='pause');
    return this.telegram.send(profile.chat_id,'Я присылаю выбранную сводку дашборда и срочные сигналы.\n\n/summary — обновить сводку\n/events — ближайшие события\n/school — расписание детей на 7 дней\n/settings — состав, дни, время и срочные уведомления',this.keyboard());
  }
  async routeCallback(profile,data,messageId){
    if(data==='summary'||data==='d:today')return this.showSummary(profile);
    if(data==='events')return this.showEvents(profile);
    if(data==='school')return this.showSchool(profile);
    if(data==='settings:open')return this.showSettings(profile);
    if(data==='settings')return this.showSettings(profile,messageId);
    const screen=data.match(/^settings:(home|content|schedule|days|times|alerts)$/);
    if(screen)return this.showSettings(profile,messageId,screen[1]);
    if(data==='pause'||data==='resume')return this.setPaused(profile,data==='pause',messageId);
    if(/^time:([01]\d|2[0-3]):[0-5]\d$/.test(data))return this.setTime(profile,data.slice(5),messageId);
    if(data==='customTimes'){
      await this.store.set('dashboard:settingsInput:'+profile.owner_id,{type:'times'},600);
      return this.settingsReply(profile,'✏️ Своё время\n\nНапиши время по Москве, например 08:30 или 08:30, 18:00. Можно указать до шести времён с 07:00 до 22:59. Этот список заменит текущий.',[[button('← К выбору времени','settings:times')]],messageId);
    }
    const section=data.match(/^section:(polza|events|proxy|usage|ycloud)$/);
    if(section)return this.changeSettings(profile,cfg=>({...cfg,sections:cfg.sections.includes(section[1])?cfg.sections.filter(x=>x!==section[1]):[...cfg.sections,section[1]]}),messageId,'content');
    if(data==='sections:all'||data==='sections:none')return this.changeSettings(profile,cfg=>({...cfg,sections:data==='sections:all'?[...SECTION_IDS]:[]}),messageId,'content');
    const day=data.match(/^day:([1-7])$/);
    if(day)return this.changeSettings(profile,cfg=>({...cfg,days:cfg.days.includes(+day[1])?cfg.days.filter(x=>x!==+day[1]):[...cfg.days,+day[1]]}),messageId,'days');
    const presets={all:[1,2,3,4,5,6,7],weekdays:[1,2,3,4,5],weekend:[6,7]};
    if(data.startsWith('days:')&&presets[data.slice(5)])return this.changeSettings(profile,cfg=>({...cfg,days:presets[data.slice(5)]}),messageId,'days');
    const time=data.match(/^toggleTime:([0-2]\d:[0-5]\d)$/);
    if(time)return this.changeSettings(profile,cfg=>({...cfg,times:cfg.times.includes(time[1])?cfg.times.filter(x=>x!==time[1]):[...cfg.times,time[1]]}),messageId,'times');
    const alert=data.match(/^alert:(polza|proxy)$/);
    if(alert)return this.changeSettings(profile,cfg=>({...cfg,alerts:{...cfg.alerts,[alert[1]]:!cfg.alerts[alert[1]]}}),messageId,'alerts');
    const monitor=data.match(/^monitor:(15|30)$/);
    if(monitor)return this.changeSettings(profile,cfg=>({...cfg,monitorMinutes:+monitor[1]}),messageId,'alerts');
    const p=data.match(/^page:([a-f0-9]{24}):(\d+)$/);
    if(p){
      const saved=await this.store.get('dashboard:pages:'+profile.owner_id+':'+p[1]),index=Number(p[2]);
      if(saved?.pages?.[index]){
        const next=index+1<saved.pages.length?[[{text:'Дальше',callback_data:'page:'+p[1]+':'+(index+1)}]]:[];
        return this.telegram.send(profile.chat_id,saved.pages[index],[...next,...this.keyboard()]);
      }
    }
    return this.telegram.send(profile.chat_id,'Эта кнопка относится к прежней версии. Открой свежую сводку.',this.keyboard());
  }
  async delivery(profile,key,text,keyboard,expected={}){
    const {profile:fresh}=await this.fresh(profile),cfg=settings(fresh.settings);
    if(cfg.paused)return 'skipped';
    if(expected.urgentKind){if(!cfg.alerts[expected.urgentKind])return 'skipped';}
    else if(dueSlot(cfg,this.now())!==expected.slot||clock(this.now()).day!==expected.day||JSON.stringify(cfg)!==JSON.stringify(expected.config))return 'skipped';
    const created=await this.store.claim(key,profile.owner_id,'delivery',{},86400*90),job=created?null:await this.store.job(key);
    if(!created&&job?.state!=='pending')return job?.state;
    if(job?.payload?.retryAt&&Date.parse(job.payload.retryAt)>+this.now())return 'pending';
    try{
      const result=await this.telegram.send(fresh.chat_id,text,keyboard);
      await this.store.finish(key,'done',{messageId:result.message_id});return 'done';
    }catch(error){
      const retry=error.message==='limited'||(error.message==='telegram_rejected'&&error.status>=500);
      const state=error.message==='delivery_unknown'?'unknown':retry?'pending':'error';
      await this.store.finish(key,state,retry?{retryAt:new Date(+this.now()+Math.max(60,error.retryAfter||0)*1000).toISOString()}:{});
      return state;
    }
  }
  async checkAlerts(profile,snapshot,cfg){
    if(cfg.alerts.polza){
      const amount=polzaAmount(snapshot),key='dashboard:polzaState:'+profile.owner_id,prior=await this.store.get(key),day=clock(this.now()).day;
      if(amount!==null){
        if(amount>=POLZA_THRESHOLD){if(!prior||prior.below)await this.store.set(key,{below:false,day},86400*90);}
        else{
          const episode=prior?.below&&prior.episode?prior.episode:crypto.randomUUID();
          const state={below:true,episode,day,...(prior?.below&&prior.episode===episode&&prior.final?{final:prior.final}:{})};
          if(!prior?.below||prior.day!==day)await this.store.set(key,state,86400*90);
          const text='Срочно · баланс Polza\n\nОсталось '+amount.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽ — ниже 70 ₽.\nhttps://dash.opalinskiy.ru/';
          if(!state.final){
            const outcome=await this.delivery(profile,'alert:polza:'+profile.owner_id+':'+episode,text,this.keyboard(),{urgentKind:'polza'});
            if(['done','unknown','error','working'].includes(outcome))await this.store.set(key,{...state,final:outcome==='working'?'unknown':outcome},86400*90);
          }
        }
      }
    }
    if(cfg.alerts.proxy)for(const alert of proxyAlerts(snapshot,this.now(),profile.owner_id))await this.delivery(profile,alert.key,alert.text,this.keyboard(),{urgentKind:'proxy'});
  }
  async tick(){
    const out={processed:0,skipped:0};
    for(const profile of await this.store.profiles()){
      const leaseKey='dashboard:tick:'+profile.owner_id;let token=null;
      try{
        let cfg=settings(profile.settings);if(cfg.paused)continue;
        const monitorKey='dashboard:lastMonitor:'+profile.owner_id,last=await this.store.get(monitorKey);
        const monitor=(cfg.alerts.polza||cfg.alerts.proxy)&&(!last||+this.now()-last.at>=cfg.monitorMinutes*60000);
        if(!monitor&&!dueSlot(cfg,this.now()))continue;
        token=await this.store.acquireLease(leaseKey,180);if(!token)continue;
        const {profile:fresh,context}=await this.fresh(profile);cfg=settings(fresh.settings);if(cfg.paused)continue;
        const day=clock(this.now()).day,slot=dueSlot(cfg,this.now());
        let reportKey=null;
        if(slot){
          const base='digest:'+fresh.owner_id+':'+day,legacy=slot==='09:00'?await this.store.job(base):null;
          const key=legacy?base:base+':'+slot,prior=await this.store.job(key);
          if(!prior||(prior.state==='pending'&&(!prior.payload?.retryAt||Date.parse(prior.payload.retryAt)<=+this.now())))reportKey=key;
        }
        const latest=await this.store.get(monitorKey);
        const check=(cfg.alerts.polza||cfg.alerts.proxy)&&(!latest||+this.now()-latest.at>=cfg.monitorMinutes*60000);
        const sections=new Set(reportKey?cfg.sections:[]);
        if(check){if(cfg.alerts.polza)sections.add('polza');if(cfg.alerts.proxy)sections.add('proxy');await this.store.set(monitorKey,{at:+this.now()},86400*35);}
        if(!sections.size)continue;
        const snapshot=await this.dashboard.snapshot(context,{sections:[...sections]});
        if(check)await this.checkAlerts(fresh,snapshot,cfg);
        if(reportKey){const result=summary(snapshot,this.now(),cfg);await this.delivery(fresh,reportKey,result.text,this.keyboard(result.remaining>0),{slot,day,config:cfg});out.processed++;}
        const cleanup='dashboard:cleanup:'+fresh.owner_id+':'+day;
        if(await this.store.claim(cleanup,fresh.owner_id,'tick',{},86400*2))await this.store.cleanup();
      }catch{out.skipped++;}
      finally{if(token)try{await this.store.releaseLease(leaseKey,token);}catch{}}
    }
    return out;
  }
}
