interface BrowserProvider { id: string; name: string; baseUrl: string; apiKey: string; model: string; quality: string; timeoutMs: number }
interface ServerProvider { id: string; host: string }
const cacheKey = 'gif-lab-browser-providers-v1', selectionKey = 'gif-lab-provider-choice-v1';
let browserProviders: BrowserProvider[] = [], serverProviders: ServerProvider[] = [], selected = '', serverSecret = '', editingId = '';
let changed: (ready: boolean, label: string) => void = () => undefined;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
function message(text: string) { element('provider-message').textContent = text; }
function validUrl(value: string) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}
function readCache() {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(cacheKey) ?? '[]');
    browserProviders = Array.isArray(parsed) ? parsed.filter((p): p is BrowserProvider => !!p && typeof p.id === 'string' && typeof p.name === 'string'
      && typeof p.apiKey === 'string' && !!p.apiKey && typeof p.baseUrl === 'string' && validUrl(p.baseUrl)
      && typeof p.model === 'string' && !!p.model && ['low', 'medium', 'high', 'xhigh', 'max'].includes(p.quality)
      && Number.isInteger(p.timeoutMs) && p.timeoutMs >= 1000 && p.timeoutMs <= 1800000) : [];
    selected = localStorage.getItem(selectionKey) ?? '';
  } catch { browserProviders = []; selected = ''; message('浏览器缓存不可读；请重新填写 provider。'); }
}
function persist() { localStorage.setItem(cacheKey, JSON.stringify(browserProviders)); localStorage.setItem(selectionKey, selected); }
function selectedBrowser() { return browserProviders.find(p => selected === `browser:${p.id}`); }
export function providerPayload() {
  const browser = selectedBrowser();
  if (browser) { const { baseUrl, apiKey, model, quality, timeoutMs } = browser; return { kind: 'browser', config: { baseUrl, apiKey, model, quality, timeoutMs } }; }
  const server = serverProviders.find(p => selected === `server:${p.id}`);
  return server && serverSecret ? { kind: 'server', id: server.id, secret: serverSecret } : undefined;
}
function render() {
  const select = element<HTMLSelectElement>('provider-choice'); select.replaceChildren(new Option('未选择 · 仍可生成离线草稿', ''));
  if (browserProviders.length) { const group = document.createElement('optgroup'); group.label = '保存在此浏览器';
    for (const p of browserProviders) group.append(new Option(p.name, `browser:${p.id}`)); select.append(group); }
  if (serverProviders.length) { const group = document.createElement('optgroup'); group.label = '已解锁的服务端列表';
    for (const p of serverProviders) group.append(new Option(p.host, `server:${p.id}`)); select.append(group); }
  select.value = selected; if (select.selectedIndex < 0) select.value = '';
  const browser = selectedBrowser(), server = serverProviders.find(p => selected === `server:${p.id}`);
  const label = browser?.name ?? server?.host ?? (selected.startsWith('server:') ? '服务端 provider 待解锁' : '未选择 provider');
  element('provider-current').textContent = label;
  element<HTMLButtonElement>('provider-edit').disabled = !browser; element<HTMLButtonElement>('provider-delete').disabled = !browser;
  element<HTMLButtonElement>('provider-lock').disabled = !serverSecret;
  changed(!!providerPayload(), label);
}
function clearEditor() {
  editingId = ''; element<HTMLFormElement>('provider-form').reset(); element('provider-save').textContent = '保存到此浏览器';
}
function newId() { const bytes = crypto.getRandomValues(new Uint8Array(16)); return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }

export function initProviders(onChange: typeof changed) {
  changed = onChange; readCache(); render();
  element('provider-choice').addEventListener('change', () => {
    selected = element<HTMLSelectElement>('provider-choice').value;
    try { persist(); message('已切换。新提交和手动重试使用当前选择；已排队请求不变。'); } catch { message('无法保存选择，下次刷新需要重新选择。'); }
    render();
  });
  element('provider-form').addEventListener('submit', event => {
    event.preventDefault(); if (!element<HTMLFormElement>('provider-form').reportValidity()) return;
    const baseUrl = input('provider-url').value.trim().replace(/\/$/, '');
    if (!validUrl(baseUrl)) { message('Base URL 必须是 HTTP(S) 地址，不应包含账号、密码、查询参数或片段。'); return; }
    const provider: BrowserProvider = { id: editingId || newId(), name: input('provider-name').value.trim(), baseUrl,
      apiKey: input('provider-key').value.trim(), model: input('provider-model').value.trim(), quality: element<HTMLSelectElement>('provider-quality').value,
      timeoutMs: Number(input('provider-timeout').value) * 1000 };
    if (!provider.name || !provider.apiKey || !provider.model) { message('请填写名称、API Key 和模型。'); return; }
    const old = browserProviders, oldSelection = selected;
    browserProviders = [...browserProviders.filter(p => p.id !== provider.id), provider]; selected = `browser:${provider.id}`;
    try { persist(); clearEditor(); render(); message('已保存在当前浏览器并选中。'); }
    catch { browserProviders = old; selected = oldSelection; message('浏览器无法保存配置，请检查存储权限或空间。'); }
  });
  element('provider-new').onclick = () => { clearEditor(); element<HTMLDetailsElement>('provider-settings').open = true; input('provider-name').focus(); };
  element('provider-edit').onclick = () => {
    const p = selectedBrowser(); if (!p) return; editingId = p.id;
    input('provider-name').value = p.name; input('provider-url').value = p.baseUrl; input('provider-key').value = p.apiKey;
    input('provider-model').value = p.model; element<HTMLSelectElement>('provider-quality').value = p.quality; input('provider-timeout').value = String(p.timeoutMs / 1000);
    element('provider-save').textContent = '保存修改到此浏览器';
  };
  element('provider-delete').onclick = () => {
    const p = selectedBrowser(); if (!p) return;
    const old = browserProviders; browserProviders = browserProviders.filter(v => v.id !== p.id); const oldSelection = selected; selected = '';
    try { persist(); clearEditor(); render(); message('已从当前浏览器删除。已排队请求继续使用提交时的配置。'); }
    catch { browserProviders = old; selected = oldSelection; message('删除未能保存，请检查浏览器存储。'); }
  };
  element('provider-unlock').onclick = () => {
    const secret = input('provider-secret').value.trim(); if (!secret) { message('请输入服务端列表访问 secret。'); return; }
    const button = element<HTMLButtonElement>('provider-unlock'); button.disabled = true;
    void fetch('/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }) }).then(async response => {
      const data = await response.json() as { providers?: ServerProvider[]; error?: string };
      if (!response.ok || !data.providers) throw new Error(data.error ?? '无法解锁列表。');
      serverProviders = data.providers; serverSecret = secret; input('provider-secret').value = '';
      if (!providerPayload() && serverProviders[0]) selected = `server:${serverProviders[0].id}`;
      try { persist(); } catch { /* Unlock is still valid for this page. */ }
      render(); message(serverProviders.length ? '列表已解锁，仅显示域名和端口；secret 仅保留在当前页面内存中。' : '已解锁，服务端列表为空。');
    }).catch(error => message(error instanceof Error ? error.message : '无法解锁列表。')).finally(() => { button.disabled = false; });
  };
  element('provider-lock').onclick = () => {
    serverSecret = ''; serverProviders = []; if (selected.startsWith('server:')) selected = '';
    try { persist(); } catch { /* Memory lock is effective regardless of storage. */ }
    render(); message('已锁定服务端列表。');
  };
  window.addEventListener('storage', event => { if ([cacheKey, selectionKey].includes(event.key ?? '')) { readCache(); render(); } });
}
