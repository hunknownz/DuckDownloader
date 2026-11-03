const statusFunction = String.raw`
function articleStatus(source) {
  if(source === 'feishu') {
    if(document.querySelector('.editor-kit-container h1') && document.querySelector('.editor-kit-container [data-block-id]')) return {ready:true};
  } else if(document.querySelector('#js_content') && document.querySelector('#activity-name')?.textContent.trim()) return {ready:true};
  const text=(document.body?.innerText || document.body?.textContent || '').slice(0,8000);
  if(/环境异常|访问过于频繁|请完成验证|滑动验证/.test(text)) return {ready:false,error:'需要在可见浏览器中手动完成访问验证'};
  if(/该内容已被发布者删除|此内容因违规无法查看|链接已过期|文档已被删除/.test(text)) return {ready:false,error:'内容已删除、受限或过期'};
  if(/you (?:do not|don't) have permission|access denied|无权访问|暂无权限|没有访问权限/i.test(text)) return {ready:false,error:'当前账号没有文档访问权限'};
  return {ready:false,needsLogin:/accounts\.(?:feishu\.cn|larksuite\.com)/.test(location.hostname)};
}`;

export const ARTICLE_STATUS_SCRIPT = `mw:({source}) => { ${statusFunction}; return articleStatus(source); }`;

export const CAPTURE_ARTICLE_SCRIPT = String.raw`mw:async ({source,timeoutMs=120000,maxSteps=400,stepDelayMs=350}) => {
${statusFunction}
const state=articleStatus(source);
if(!state.ready) throw new Error(state.error || '内容尚不可读，请先登录');
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const clean=value=>String(value || '').replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/g,'').trim();
function visibleTitle(node) {
  if(!node)return '';
  const clone=node.cloneNode(true);
  for(const hidden of clone.querySelectorAll('script,style,.page-block-title-icon'))hidden.remove();
  return clean(clone.textContent);
}
const pause=()=>new Promise(resolve=>setTimeout(resolve,stepDelayMs));
const deadline=Date.now()+timeoutMs;
const images=new Map();
const imageErrors=new Map();
const warnings=[];
let encodedBytes=0;
let complete=true;
function imageReference(image) {
  let reference=(source==='wechat' && image.getAttribute('data-src')) || image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || '';
  if(!reference) { imageErrors.set('missing-image-address','图片地址缺失'); return undefined; }
  try { reference=new URL(reference,location.href).href; } catch { return undefined; }
  if(images.has(reference)) return reference;
  if(/^https?:/.test(reference)) {
    images.set(reference,{reference,sourceUrl:reference,mediaType:''});
    imageErrors.delete(reference);
    return reference;
  }
  if(!image.complete || !image.naturalWidth) { imageErrors.set(reference,'图片尚未加载'); return undefined; }
  if(image.naturalWidth*image.naturalHeight > 40000000) { imageErrors.set(reference,'图片像素数量超出限制'); return undefined; }
  if(!/^(?:blob:https?:|data:image\/)/.test(reference)) { imageErrors.set(reference,'不支持的图片地址'); return undefined; }
  try {
    const canvas=document.createElement('canvas');
    canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
    canvas.getContext('2d').drawImage(image,0,0);
    const dataBase64=canvas.toDataURL('image/png').split(',')[1];
    if(!dataBase64 || encodedBytes+dataBase64.length > 48*1024*1024) throw new Error('图片数据超出限制');
    encodedBytes+=dataBase64.length;
    images.set(reference,{reference,sourceUrl:location.href.split('#')[0],mediaType:'image/png',dataBase64});
    imageErrors.delete(reference);
    return reference;
  } catch(error) { imageErrors.set(reference,String(error)); return undefined; }
}
function inline(node) {
  if(node.nodeType===3) return escape(node.textContent.replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/g,''));
  if(node.nodeType!==1) return '';
  const tag=node.tagName.toLowerCase();
  if(['script','style','svg','iframe','object','embed','noscript','link','meta','base','form','button','input','textarea'].includes(tag)) return '';
  if(tag==='br') return '<br>';
  if(tag==='img') {const ref=imageReference(node); return ref ? '<img src="'+escape(ref)+'" alt="'+escape(node.alt || 'image')+'">' : '<span>[Image unavailable]</span>';}
  let content=[...node.childNodes].map(inline).join('');
  if(tag==='a') { const href=node.getAttribute('href') || ''; try {const url=new URL(href,location.href); if(/^https?:$/.test(url.protocol))content='<a href="'+escape(url.href)+'">'+content+'</a>';}catch{} }
  if(['bold','700','800','900'].includes(node.style?.fontWeight) || ['b','strong'].includes(tag)) content='<strong>'+content+'</strong>';
  if(node.style?.fontStyle==='italic' || ['i','em'].includes(tag)) content='<em>'+content+'</em>';
  if(['p','div','section','article','blockquote','pre','code','ul','ol','li','table','thead','tbody','tr','th','td','h1','h2','h3','h4','h5','h6','figure','figcaption','hr'].includes(tag)) content='<'+tag+'>'+content+'</'+tag+'>';
  return content;
}
let html='';
let title='';
let sections=0;
if(source==='feishu') {
  title=visibleTitle(document.querySelector('.editor-kit-container h1')).replace(/^💡\s*/,'');
  const scroller=document.querySelector('.bear-web-x-container');
  if(!scroller) throw new Error('找不到飞书文档滚动容器');
  const originalTop=scroller.scrollTop;
  const blocks=new Map(); const toc=new Map(); const unsupported=new Set();
  let bottom=0; let finished=false;
  try {
    scroller.scrollTop=0; await pause();
    for(let step=0;step<maxSteps;step++) {
      for(const link of document.querySelectorAll('.catalogue__scroller a[href]')) {
        const id=(link.getAttribute('href') || '').replace(/^#/,'');
        if(id && id!==location.pathname.split('/').pop())toc.set(id,clean(link.textContent));
      }
      for(const element of document.querySelectorAll('.editor-kit-container [data-block-id]')) {
        const type=element.getAttribute('data-block-type') || 'text';
        if(!['page','callout','text','image','bullet','ordered','quote','code','divider'].includes(type) && !/^heading[1-9]$/.test(type))unsupported.add(type);
        if(element.querySelector('[data-block-id]'))continue;
        const id=element.getAttribute('data-record-id') || element.getAttribute('data-block-id');
        const order=Number(element.getAttribute('data-block-id'));
        const content=[...element.querySelectorAll('.ace-line')].map(line=>[...line.childNodes].map(inline).join('')).join('<br>');
        let block={id,order,type,html:content};
        if(type==='image') {
          const existing=blocks.get(id);
          const image=element.querySelector('img');
          const ref=existing?.imageReference || (image && imageReference(image));
          block.imageReference=ref;
          block.html=ref ? '<figure><img src="'+escape(ref)+'" alt="Document image"></figure>' : '<p>[Image unavailable]</p>';
        } else if(/^heading[1-9]$/.test(type)) {
          const level=Math.min(6,Number(type.slice(-1))+1);block.html='<h'+level+'>'+content+'</h'+level+'>';
        } else if(type==='divider')block.html='<hr>';
        else if(type==='code')block.html='<pre><code>'+escape(clean(element.textContent))+'</code></pre>';
        else if(type==='quote')block.html='<blockquote>'+content+'</blockquote>';
        else if(type==='bullet' || type==='ordered')block.html='<p>'+ (type==='bullet'?'• ':'')+content+'</p>';
        else block.html=content ? '<p>'+content+'</p>' : '';
        blocks.set(id,block);
      }
      bottom=scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-3 ? bottom+1 : 0;
      if(bottom>=3){finished=true;break;}
      if(Date.now()>=deadline)break;
      scroller.scrollTop+=Math.max(100,Math.min(500,scroller.clientHeight*.75)); await pause();
    }
  } finally {scroller.scrollTop=originalTop;}
  if(!finished){complete=false;warnings.push('飞书滚动采集超时或达到上限，已保留可读内容');}
  for(const [id,text] of toc)if(!blocks.has(id)){complete=false;warnings.push('未加载章节：'+text);}
  for(const type of unsupported){complete=false;warnings.push('尚未完整适配的飞书内容块：'+type);}
  const ordered=[...blocks.values()].sort((a,b)=>a.order-b.order);
  for(const block of ordered)if(block.type==='image' && !block.imageReference){complete=false;warnings.push('未能保存配图：'+block.id);}
  sections=ordered.filter(block=>/^heading/.test(block.type)).length;
  html=ordered.map(block=>block.html).join('\n');
} else {
  const content=document.querySelector('#js_content');
  if(content.querySelector('iframe,video,audio,mp-video,mpvoice,mp-common-videosnap')) {
    complete=false;warnings.push('公众号包含尚未导出的嵌入媒体，已保留可读图文');
  }
  title=visibleTitle(document.querySelector('#activity-name')) || clean(document.title);
  const scroller=document.scrollingElement || document.documentElement;
  const originalTop=scroller.scrollTop;
  let bottom=0; let finished=false;
  for(const image of content.querySelectorAll('img')) {
    if(image.getAttribute('data-src'))image.setAttribute('src',image.getAttribute('data-src'));
    image.loading='eager';
  }
  try {
    scroller.scrollTop=0; await pause();
    for(let step=0;step<maxSteps;step++) {
      for(const image of content.querySelectorAll('img'))imageReference(image);
      bottom=scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-3 ? bottom+1 : 0;
      if(bottom>=3){finished=true;break;}
      if(Date.now()>=deadline)break;
      scroller.scrollTop+=Math.max(300,scroller.clientHeight*.8);await pause();
    }
  } finally {scroller.scrollTop=originalTop;}
  if(!finished){complete=false;warnings.push('公众号页面未能完成滚动加载');}
  html=[...content.childNodes].map(inline).join('');
  sections=1;
}
for(const [ref,error] of imageErrors)if(!images.has(ref)){complete=false;warnings.push('图片未完成加载：'+error);}
if(!html.trim())throw new Error('未能提取正文');
return {title,sourceUrl:location.href.split('#')[0],html,images:[...images.values()],warnings,complete,sections};
}`;

export const ARTICLE_RESOURCES_SCRIPT =
  "mw:async () => { await document.fonts.ready; return [...document.images].every(image => image.complete && image.naturalWidth > 0); }";
