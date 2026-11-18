export const TZ = 'Europe/Moscow';
export const DASHBOARD_URL = 'https://dash.opalinskiy.ru/';
export const DEFAULTS = Object.freeze({digestTime:'09:00',paused:false});
export const SECTIONS=Object.freeze([{id:'polza',label:'Баланс Polza'},{id:'events',label:'Ближайшие события'},{id:'proxy',label:'Срок прокси'},{id:'usage',label:'Supabase'},{id:'ycloud',label:'Yandex Cloud'}]);
export const SECTION_IDS=Object.freeze(SECTIONS.map(x=>x.id));
export const clean = (s,max=500) => String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,max);
export const oneLine = (s,max=200) => clean(s,max).replace(/\s+/g,' ');
const fmt = new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function clock(at=new Date()){
  const p=Object.fromEntries(fmt.formatToParts(new Date(at)).map(x=>[x.type,x.value]));
  return {day:p.year+'-'+p.month+'-'+p.day,time:p.hour+':'+p.minute,minute:+p.hour*60 + +p.minute};
}
export const dayOffset=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function quiet(at){const m=clock(at).minute;return m>=1380||m<420;}
export function settings(input={}){
  const times=input.times??[input.digestTime??DEFAULTS.digestTime];
  const sections=input.sections??SECTION_IDS,days=input.days??[1,2,3,4,5,6,7];
  if(!Array.isArray(times)||times.length>6)throw Error('bad_times');
  for(const time of times){
    if(typeof time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('bad_time');
    const [h,m]=time.split(':').map(Number);
    if(h*60+m<420||h*60+m>=1380)throw Error('quiet_time');
  }
  if(!Array.isArray(sections)||sections.some(x=>!SECTION_IDS.includes(x))||!Array.isArray(days)||days.some(x=>!Number.isInteger(x)||x<1||x>7))throw Error('bad_settings');
  const monitorMinutes=input.monitorMinutes??30;
  if(![15,30].includes(monitorMinutes))throw Error('bad_settings');
  const normalized=[...new Set(times)].sort();
  return {digestTime:normalized[0]??DEFAULTS.digestTime,times:normalized,days:[...new Set(days)].sort((a,b)=>a-b),sections:SECTION_IDS.filter(x=>sections.includes(x)),alerts:{polza:input.alerts?.polza!==false,proxy:input.alerts?.proxy!==false},monitorMinutes,paused:!!input.paused};
}
export function dueSlot(cfg,now){
  cfg=settings(cfg);const c=clock(now),weekday=new Date(c.day+'T12:00:00Z').getUTCDay()||7;
  if(cfg.paused||quiet(now)||!cfg.sections.length||!cfg.days.includes(weekday))return null;
  return cfg.times.filter(time=>{const [h,m]=time.split(':').map(Number),delta=c.minute-h*60-m;return delta>=0&&delta<=120;}).at(-1)??null;
}
export const digestDue=(cfg,now)=>dueSlot(cfg,now)!==null;
const number=x=>typeof x==='number'&&Number.isFinite(x);
const rub=x=>x.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽';
const date=(x,withTime=false)=>new Intl.DateTimeFormat('ru-RU',{timeZone:TZ,day:'numeric',month:'short',...(withTime?{hour:'2-digit',minute:'2-digit'}:{})}).format(new Date(x));
export function tileText(kind,data,now){
  if(!data||data.status!=='ok')return 'Данные на дашборде сейчас недоступны.';
  if(kind==='polza')return number(data.amount)?rub(data.amount)+(data.amount<100?' · пора пополнить':''):'Баланс на дашборде не получен.';
  if(kind==='proxy'){
    if(!Array.isArray(data.orders))return 'Срок на дашборде не получен.';
    const orders=data.orders.map(x=>({...x,t:Date.parse(x.expires_at)})).filter(x=>Number.isFinite(x.t)).sort((a,b)=>a.t-b.t);
    if(!orders.length)return data.orders.length?'Срок на дашборде не указан.':'Заказов нет.';
    const o=orders[0],left=o.t-+new Date(now),days=Math.floor(left/86400000);
    const when=left<=0?'срок истёк':days>=1?'через '+days+' дн.':'через '+Math.max(0,Math.floor(left/3600000))+' ч';
    return (oneLine(o.country,40)||'Прокси')+' · '+when+' · '+date(o.t)+(left>0&&left<3*86400000?' · скоро продлевать':'');
  }
  if(kind==='usage'){
    if(![data.db_bytes,data.db_limit,data.storage_bytes,data.storage_limit].every(number)||data.db_limit<=0||data.storage_limit<=0)return 'Заполненность на дашборде не получена.';
    const db=Math.round(data.db_bytes/data.db_limit*100),storage=Math.round(data.storage_bytes/data.storage_limit*100);
    return 'База '+db+'% · '+Math.round(data.db_bytes/1048576)+' из '+Math.round(data.db_limit/1048576)+' МБ; файлы '+storage+'%'+(Math.max(db,storage)>=80?' · близко к лимиту':'');
  }
  if(kind==='ycloud')return ({ok:'Работает',blocked:'Заблокировано · проверь баланс',partial:'Часть сайтов не отвечает · проверь баланс'})[data.state]||'Статус на дашборде не получен.';
  return '';
}
export function upcoming(events,now){
  if(!Array.isArray(events))return [];
  const day=clock(now).day,limit=Date.parse(day+'T00:00:00+03:00')+2*86400000;
  return events.filter(e=>{
    if(!e||!e.start||e.status==='cancelled')return false;
    const start=Date.parse(e.start),end=Date.parse(e.end||e.start);
    return Number.isFinite(start)&&Number.isFinite(end)&&end>+new Date(now)&&start<limit;
  }).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
}
const schoolNames={dima:'Дима',danya:'Даня',anya:'Аня',family:'Семья'};
export function eventLine(e){
  const allDay=e.all_day||!String(e.start).includes('T');
  const child=e.occurrence?schoolNames[e.child]:'';
  return date(allDay?e.start.slice(0,10)+'T12:00:00+03:00':e.start,!allDay)+(allDay?' · весь день':'')+
    ' — '+(child?child+' · ':'')+(oneLine(e.title,160)||'Без названия')+(e.place?' · '+oneLine(e.place,90):'')+(e.tentative?' · уточнить':'');
}
export function schoolText(events,from,to,child){
  const range=date(from+'T12:00:00+03:00')+' — '+date(to+'T12:00:00+03:00');
  const title='Школа и кружки · '+range+(schoolNames[child]?' · '+schoolNames[child]:'');
  const rows=events.filter(e=>!child||e.child===child);
  const lines=[title,'Время московское.'];
  let lastDay;
  const schoolDepartures=new Set();
  for(const e of rows){
    if(e.occurrence!==lastDay){
      lines.push('\n'+new Intl.DateTimeFormat('ru-RU',{timeZone:TZ,weekday:'long',day:'numeric',month:'long'}).format(new Date(e.start)));
      lastDay=e.occurrence;
    }
    const school=e.category==='school'&&e.school_kind!=='kindergarten';
    const schoolKey=e.occurrence+'/'+e.child;
    const leave=e.from_school?'':e.departure_time||(e.travel_out==null?'':clock(new Date(Date.parse(e.start)-(e.travel_out+5)*60000)).time);
    const departure=leave&&(!school||!schoolDepartures.has(schoolKey))?' · выйти из дома '+leave:'';
    if(school)schoolDepartures.add(schoolKey);
    const back=e.travel_back==null?'':' · обратно '+e.travel_back+' мин';
    const time=e.all_day?'Весь день':e.start_time+'–'+e.end_time;
    lines.push(time+' · '+(schoolNames[e.child]||'Семья')+' · '+oneLine(e.title,160)+(e.place?' · '+oneLine(e.place,90):'')+
      (e.tentative?' · уточнить':'')+departure+back);
  }
  if(!rows.length)lines.push('\nВ эти дни событий нет.');
  lines.push('\n'+DASHBOARD_URL+'school/');
  return lines.join('\n');
}
export function eventsText(snapshot,now,{all=false}={}){
  if(snapshot.events?.state!=='ok'||!Array.isArray(snapshot.events.data?.events))return {text:'Ближайшие события\nДанные на дашборде пока недоступны.',remaining:0};
  const rows=upcoming(snapshot.events.data.events,now),shown=all?rows:rows.slice(0,5);
  const remaining=rows.length-shown.length;
  const missing=snapshot.events.data.schoolUnavailable?'\nРаздел «Школа и кружки» недоступен.':
    snapshot.events.data.calendarUnavailable?'\nСемейный календарь Google недоступен.':'';
  return {text:'Ближайшие события\n'+(shown.length?shown.map(eventLine).join('\n'):missing?'Из доступных источников событий нет.':'На сегодня и завтра событий нет.')+(remaining?'\nЕщё событий: '+remaining+'.':'')+missing,
    remaining};
}
export function summary(snapshot,now,input={}){
  const cfg=settings(input),selected=new Set(cfg.sections);
  const lines=['Сводка дашборда · '+clock(now).day];
  if(!selected.size)lines.push('Ни один блок не выбран. Выбери содержимое в настройках.');
  if(snapshot.configError&&cfg.sections.some(x=>x!=='events'))lines.push('Статусные плашки: конфигурация дашборда недоступна.');
  for(const tile of snapshot.tiles||[])if(selected.has(tile.kind))lines.push(oneLine(tile.title,60)+'\n'+tileText(tile.kind,tile.result?.state==='ok'?tile.result.data:null,now));
  const events=selected.has('events')?eventsText(snapshot,now):{remaining:0};
  if(events.text)lines.push(events.text);
  lines.push('Обновлено '+clock(now).time+' МСК\n'+DASHBOARD_URL);
  return {text:lines.join('\n\n'),remaining:events.remaining};
}
export function paginate(text,max=3400){
  const pages=[];let page='';
  for(let line of String(text).split('\n')){
    while(line.length>max){if(page){pages.push(page);page='';}pages.push(line.slice(0,max));line=line.slice(max);}
    if(page.length+line.length+1>max){pages.push(page);page='';}
    page+=(page?'\n':'')+line;
  }
  if(page)pages.push(page);return pages.length?pages:['Данных нет.'];
}
