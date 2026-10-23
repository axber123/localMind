import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Cpu,
  Database,
  Download,
  FolderOpen,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import type { AppSettings, LlmSettings, ModelProgressEvent, RagSettings } from '../../../../shared/types'
import { ClientError, errorText, unwrap } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  Field,
  Input,
  ProgressBar,
  Spinner,
  useToast
} from '../../components/ui'

const CONSENT_VERSION = 1

export function SettingsPage() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [llm, setLlm] = useState<LlmSettings | null>(null)
  const [rag, setRag] = useState<RagSettings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [modelProgress, setModelProgress] = useState<ModelProgressEvent | null>(null)
  const [consentOrigin, setConsentOrigin] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => unwrap(window.localMind.settings.get()) })
  const info = useQuery({ queryKey: ['info'], queryFn: () => unwrap(window.localMind.app.getInfo()) })
  const model = useQuery({ queryKey: ['model'], queryFn: () => unwrap(window.localMind.model.status()) })

  useEffect(() => {
    if (settings.data) {
      setLlm((current) => current ?? settings.data.llm)
      setRag((current) => current ?? settings.data.rag)
    }
  }, [settings.data])

  useEffect(() => {
    return window.localMind.modelEvents.onProgress((event) => setModelProgress(event))
  }, [])

  const saveLlm = async (): Promise<void> => {
    if (!llm) return
    setBusy('llm')
    try {
      const next = await unwrap(window.localMind.settings.update({ llm }))
      setLlm(next.llm)
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('模型配置已保存')
    } catch (error) {
      toast.error('保存失败', errorText(error))
    } finally {
      setBusy(null)
    }
  }

  const saveRag = async (): Promise<void> => {
    if (!rag) return
    setBusy('rag')
    try {
      const next = await unwrap(window.localMind.settings.update({ rag }))
      setRag(next.rag)
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('检索设置已保存', '切分参数变化后，已有文档会标记为需要重建索引。')
    } catch (error) {
      toast.error('保存失败', errorText(error))
    } finally {
      setBusy(null)
    }
  }

  const saveKey = async (): Promise<void> => {
    if (!apiKey.trim()) return
    setBusy('key')
    try {
      await unwrap(window.localMind.settings.setApiKey(apiKey))
      setApiKey('')
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('API Key 已加密保存', 'Windows 下使用系统 DPAPI 加密。')
    } catch (error) {
      toast.error('保存密钥失败', errorText(error))
    } finally {
      setBusy(null)
    }
  }

  const clearKey = async (): Promise<void> => {
    try {
      await unwrap(window.localMind.settings.clearApiKey())
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('API Key 已清除')
    } catch (error) {
      toast.error('清除失败', errorText(error))
    }
  }

  const testLlm = async (): Promise<void> => {
    setBusy('test-llm')
    try {
      const result = await unwrap(window.localMind.settings.testLlm())
      toast.success('模型连接成功', `延迟 ${result.latencyMs} ms · ${result.message}`)
    } catch (error) {
      if (error instanceof ClientError && error.code === 'CLOUD_CONSENT_REQUIRED' && error.details) {
        setConsentOrigin(error.details)
      } else {
        toast.error('连接测试失败', errorText(error))
      }
    } finally {
      setBusy(null)
    }
  }

  const downloadModel = async (): Promise<void> => {
    setBusy('download')
    try {
      const result = await unwrap(window.localMind.model.download())
      await queryClient.invalidateQueries({ queryKey: ['model'] })
      await queryClient.invalidateQueries({ queryKey: ['stats'] })
      if (result.state === 'ready') toast.success('本地模型已就绪')
      else toast.error('模型未就绪', result.message)
    } catch (error) {
      toast.error('下载模型失败', errorText(error))
    } finally {
      setBusy(null)
    }
  }

  const testModel = async (): Promise<void> => {
    setBusy('test-model')
    try {
      const result = await unwrap(window.localMind.model.test())
      toast.success('本地模型正常', `${result.dimensions} 维 · ${result.latencyMs} ms`)
      await queryClient.invalidateQueries({ queryKey: ['model'] })
    } catch (error) {
      toast.error('模型测试失败', errorText(error))
    } finally {
      setBusy(null)
    }
  }

  if (settings.isLoading || !llm || !rag) return <Spinner label="加载设置…" />
  if (settings.isError) return <ErrorState message={errorText(settings.error)} retry={() => void settings.refetch()} />

  return (
    <div className="page settings-page">
      <header className="page-header">
        <div><h1>设置</h1><p>模型连接、本地知识库和隐私边界。</p></div>
        <Badge tone="success"><ShieldCheck size={13} /> 本地优先</Badge>
      </header>

      <div className="settings-grid">
        <section className="settings-card">
          <div className="settings-card__head"><Cpu size={18} /><div><h2>AI 模型服务</h2><p>OpenAI 兼容 API。请求只由 Electron 主进程发出。</p></div></div>
          <div className="form-grid">
            <Field label="API Base URL" hint="例如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1">
              <Input value={llm.baseUrl} onChange={(event) => setLlm({ ...llm, baseUrl: event.target.value })} />
            </Field>
            <Field label="模型名称"><Input value={llm.model} onChange={(event) => setLlm({ ...llm, model: event.target.value })} /></Field>
            <div className="form-row">
              <Field label="超时时间（毫秒）"><Input type="number" min={5000} max={300000} value={llm.timeoutMs} onChange={(event) => setLlm({ ...llm, timeoutMs: Number(event.target.value) })} /></Field>
              <Field label="Temperature"><Input type="number" min={0} max={2} step={0.1} value={llm.temperature} onChange={(event) => setLlm({ ...llm, temperature: Number(event.target.value) })} /></Field>
            </div>
            <label className="checkbox-row"><input type="checkbox" checked={llm.stream} onChange={(event) => setLlm({ ...llm, stream: event.target.checked })} /> 使用流式响应</label>
          </div>
          <div className="settings-actions">
            <Button variant="primary" icon={<Save size={14} />} loading={busy === 'llm'} onClick={() => void saveLlm()}>保存配置</Button>
            <Button icon={<RefreshCw size={14} />} loading={busy === 'test-llm'} onClick={() => void testLlm()}>测试连接</Button>
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-card__head"><KeyRound size={18} /><div><h2>API Key</h2><p>密钥使用 Windows DPAPI 加密，不写入 SQLite 或前端资源。</p></div></div>
          <div className="key-status">
            <LockKeyhole size={16} />
            {settings.data?.hasApiKey ? <span>已保存密钥 <code>{settings.data.apiKeyHint}</code></span> : <span>尚未保存 API Key</span>}
            <Badge tone={settings.data?.hasApiKey ? 'success' : 'neutral'}>{settings.data?.hasApiKey ? '已配置' : '未配置'}</Badge>
          </div>
          <div className="inline-form">
            <Input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="输入新的 API Key" />
            <Button variant="primary" loading={busy === 'key'} disabled={!apiKey.trim()} onClick={() => void saveKey()}>保存密钥</Button>
            {settings.data?.hasApiKey && <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void clearKey()}>清除</Button>}
          </div>
          <p className="fine-print">API Key 不会回传到页面，也不会出现在日志中。本地 Ollama 等服务可以不填写密钥。</p>
        </section>

        <section className="settings-card">
          <div className="settings-card__head"><Database size={18} /><div><h2>本地 Embedding 模型</h2><p>解析、切分、推理和检索均在本地执行。</p></div></div>
          <div className="model-manage">
            <div className="model-manage__icon">E5</div>
            <div className="model-manage__body">
              <strong>{model.data?.displayName ?? 'multilingual-e5-small'}</strong>
              <span>{model.data?.dimensions ?? 384} 维 · 最长 {model.data?.maxTokens ?? 512} tokens · MIT 许可证</span>
              <span>来源：ModelScope / intfloat · FP32 ONNX</span>
              <Badge tone={model.data?.state === 'ready' ? 'success' : model.data?.state === 'error' ? 'danger' : 'neutral'}>
                {model.data?.state === 'ready' ? '就绪' : model.data?.state === 'downloading' ? '下载中' : model.data?.state === 'error' ? '错误' : '未下载'}
              </Badge>
            </div>
          </div>
          {(model.data?.state === 'downloading' || modelProgress?.state === 'downloading') && (
            <ProgressBar
              value={modelProgress?.progress ?? model.data?.progress ?? 0}
              label={`${formatBytes(modelProgress?.downloadedBytes ?? model.data?.downloadedBytes ?? 0)} / ${formatBytes(modelProgress?.totalBytes ?? model.data?.totalBytes ?? 0)}`}
            />
          )}
          {model.data?.message && <div className={`inline-note ${model.data.state === 'error' ? 'inline-note--danger' : ''}`}>{model.data.message}</div>}
          {model.data?.needsReindex && <div className="inline-note inline-note--warning">模型或切分配置已变化，已有索引需要在“我的资料”中重建。</div>}
          <div className="settings-actions">
            <Button
              variant="primary"
              icon={<Download size={14} />}
              loading={busy === 'download'}
              disabled={model.data?.state === 'downloading'}
              onClick={() => void downloadModel()}
            >
              {model.data?.state === 'ready' ? '校验/重新下载' : '下载模型（约 465 MB）'}
            </Button>
            {model.data?.state === 'downloading' && <Button onClick={() => void unwrap(window.localMind.model.cancelDownload())}>取消下载</Button>}
            <Button icon={<Cpu size={14} />} loading={busy === 'test-model'} disabled={model.data?.state !== 'ready'} onClick={() => void testModel()}>测试模型</Button>
          </div>
          <p className="fine-print">首次下载需要网络。模型就绪后，断网也能完成本地 Embedding 和向量检索。模型固定使用 MIT 许可证的 intfloat/multilingual-e5-small（384 维，512 token 上限）。</p>
        </section>

        <section className="settings-card">
          <div className="settings-card__head"><Database size={18} /><div><h2>检索与切分</h2><p>切分参数同时受 Embedding 模型 512 token 输入限制约束。</p></div></div>
          <div className="form-row">
            <Field label="Top K"><Input type="number" min={1} max={20} value={rag.topK} onChange={(event) => setRag({ ...rag, topK: Number(event.target.value) })} /></Field>
            <Field label="相似度阈值"><Input type="number" min={-1} max={1} step={0.05} value={rag.scoreThreshold} onChange={(event) => setRag({ ...rag, scoreThreshold: Number(event.target.value) })} /></Field>
          </div>
          <div className="form-row">
            <Field label="上下文上限（字符）"><Input type="number" min={1000} max={30000} step={500} value={rag.maxContextChars} onChange={(event) => setRag({ ...rag, maxContextChars: Number(event.target.value) })} /></Field>
            <Field label="Chunk Size（tokens）"><Input type="number" min={64} max={480} value={rag.chunkSize} onChange={(event) => setRag({ ...rag, chunkSize: Number(event.target.value) })} /></Field>
            <Field label="Overlap（tokens）"><Input type="number" min={0} max={400} value={rag.chunkOverlap} onChange={(event) => setRag({ ...rag, chunkOverlap: Number(event.target.value) })} /></Field>
          </div>
          <div className="settings-actions"><Button variant="primary" icon={<Save size={14} />} loading={busy === 'rag'} onClick={() => void saveRag()}>保存检索设置</Button></div>
        </section>

        <section className="settings-card">
          <div className="settings-card__head"><FolderOpen size={18} /><div><h2>数据位置</h2><p>这些目录不会随应用更新被删除。</p></div></div>
          <div className="path-list">
            {info.data && (
              <>
                <div><span>数据库</span><code>{info.data.databasePath}</code><Button size="sm" variant="ghost" onClick={() => void unwrap(window.localMind.app.openPath('database'))}>打开</Button></div>
                <div><span>笔记</span><code>{info.data.notesPath}</code><Button size="sm" variant="ghost" onClick={() => void unwrap(window.localMind.app.openPath('notes'))}>打开</Button></div>
                <div><span>模型</span><code>{info.data.modelsPath}</code><Button size="sm" variant="ghost" onClick={() => void unwrap(window.localMind.app.openPath('models'))}>打开</Button></div>
                <div><span>日志</span><code>{info.data.logsPath}</code><Button size="sm" variant="ghost" onClick={() => void unwrap(window.localMind.app.openPath('logs'))}>打开</Button></div>
              </>
            )}
          </div>
        </section>

        <section className="settings-card settings-card--privacy">
          <div className="settings-card__head"><ShieldCheck size={18} /><div><h2>隐私说明</h2><p>请区分“本地 RAG”和“云端生成”。</p></div></div>
          <ul className="privacy-list">
            <li>网页版上传的资料会复制到本机数据目录的 library 文件夹，由本地 Node 服务管理，不会上传到云端。</li>
            <li>文档解析、文本切分、Embedding 和向量检索在本地完成。</li>
            <li>使用云端 LLM 时，仅当前问答需要的检索片段和对话上下文会发送到配置的服务地址。</li>
            <li>文档内容可能包含提示词注入；系统会把它当作资料，而不是可执行指令。</li>
            <li>日志不记录 API Key，也不记录完整文档内容。</li>
          </ul>
          <div className="settings-meta">
            <span>版本 {info.data?.version ?? '0.1.0'}</span>
            <span>{info.data?.electronVersion ? `Electron ${info.data.electronVersion}` : '网页版 · 本机 Node 服务'}</span>
            <span>模型安装于 {formatDate(model.data?.installedAt)}</span>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(consentOrigin)}
        title="测试云端模型连接？"
        description={<p>一条测试消息会发送到 {consentOrigin}。这不会发送你的任何文档内容。</p>}
        confirmLabel="确认并测试"
        onConfirm={() => {
          if (!consentOrigin) return
          void unwrap(window.localMind.settings.acceptCloudConsent(consentOrigin, CONSENT_VERSION))
            .then(() => { setConsentOrigin(null); void testLlm() })
            .catch((error) => toast.error('确认失败', errorText(error)))
        }}
        onClose={() => setConsentOrigin(null)}
      />
    </div>
  )
}
