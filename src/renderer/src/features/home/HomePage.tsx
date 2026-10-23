import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Bot,
  FileText,
  FolderOpen,
  Globe2,
  ListTodo,
  NotebookPen,
  Plus,
  Sparkles
} from 'lucide-react'
import { unwrap } from '../../lib/api'
import { formatRelative, truncate } from '../../lib/format'
import { Badge, Button, ErrorState, PageHeader, ProgressBar, Spinner, useToast } from '../../components/ui'

export function HomePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => unwrap(window.localMind.app.getStats()) })
  const recent = useQuery({ queryKey: ['recent'], queryFn: () => unwrap(window.localMind.app.getRecent()) })
  const model = useQuery({ queryKey: ['model'], queryFn: () => unwrap(window.localMind.model.status()) })

  if (stats.isLoading) return <Spinner label="正在加载工作台…" />
  if (stats.isError) {
    return <ErrorState message={stats.error instanceof Error ? stats.error.message : '加载失败'} retry={() => void stats.refetch()} />
  }
  const data = stats.data!
  const job = data.activeJob

  return (
    <div className="page home-page">
      <PageHeader
        title="今天想学点什么？"
        description="把网站、资料、笔记和 AI 放在同一个本地学习空间里。"
        actions={
          <>
            <Button icon={<Plus size={15} />} onClick={() => navigate('/folders?new=1')}>
              添加资料夹
            </Button>
            <Button variant="primary" icon={<Bot size={15} />} onClick={() => navigate('/chat')}>
              问问 AI
            </Button>
          </>
        }
      />

      <section className="hero-card">
        <div className="hero-card__glow" />
        <div className="hero-card__copy">
          <span className="eyebrow"><Sparkles size={14} /> LOCAL-FIRST LEARNING</span>
          <h2>资料保存在本地，知识可以被搜索，AI 可以基于资料回答。</h2>
          <p>文档解析、文本切分、Embedding 和向量检索都在你的电脑上完成。只有你主动配置云端模型时，必要的检索片段才会发送出去。</p>
        </div>
        <div className="hero-card__orb">
          <div className="orb-ring orb-ring--one" />
          <div className="orb-ring orb-ring--two" />
          <div className="orb-core"><Bot size={45} /></div>
        </div>
      </section>

      {job && (
        <section className="panel panel--job">
          <div className="panel__head">
            <div>
              <span className="eyebrow">{job.kind === 'scan' ? '正在扫描资料夹' : '正在建立知识库索引'}</span>
              <h3>{job.message ?? '处理中…'}</h3>
            </div>
            <Badge tone="info">{job.processed}/{job.total || '?'}</Badge>
          </div>
          <ProgressBar value={job.total ? job.processed / job.total : 0} label={`${job.failed} 个失败`} />
          <div className="panel__foot">
            <Button size="sm" variant="ghost" onClick={() => navigate('/folders')}>查看进度</Button>
          </div>
        </section>
      )}

      <section className="stat-grid">
        <button className="stat-card" onClick={() => navigate('/folders')}>
          <span className="stat-card__icon tone-indigo"><FolderOpen size={19} /></span>
          <div><strong>{data.folders}</strong><span>资料夹</span></div>
          <ArrowRight size={16} />
        </button>
        <button className="stat-card" onClick={() => navigate('/documents')}>
          <span className="stat-card__icon tone-sky"><FileText size={19} /></span>
          <div><strong>{data.documents}</strong><span>文档 · {data.indexedDocuments} 已索引</span></div>
          <ArrowRight size={16} />
        </button>
        <button className="stat-card" onClick={() => navigate('/notes')}>
          <span className="stat-card__icon tone-amber"><NotebookPen size={19} /></span>
          <div><strong>{data.notes}</strong><span>Markdown 笔记</span></div>
          <ArrowRight size={16} />
        </button>
        <button className="stat-card" onClick={() => navigate('/websites')}>
          <span className="stat-card__icon tone-emerald"><Globe2 size={19} /></span>
          <div><strong>{data.websites}</strong><span>收藏网站</span></div>
          <ArrowRight size={16} />
        </button>
        <button className="stat-card" onClick={() => navigate('/tasks')}>
          <span className="stat-card__icon tone-rose"><ListTodo size={19} /></span>
          <div><strong>{data.openTasks}</strong><span>待完成任务</span></div>
          <ArrowRight size={16} />
        </button>
        <button className="stat-card" onClick={() => navigate('/chat')}>
          <span className="stat-card__icon tone-violet"><Bot size={19} /></span>
          <div><strong>{data.chats}</strong><span>AI 学习对话</span></div>
          <ArrowRight size={16} />
        </button>
      </section>

      <div className="home-columns">
        <section className="panel">
          <div className="panel__head">
            <div><span className="eyebrow">最近学习</span><h3>继续阅读与整理</h3></div>
            <Button size="sm" variant="ghost" onClick={() => navigate('/documents')}>全部文档</Button>
          </div>
          {recent.isLoading && <Spinner label="加载最近内容…" />}
          {recent.data?.length === 0 && (
            <div className="soft-empty">还没有内容。先添加一个资料夹，或写一篇笔记。</div>
          )}
          <div className="recent-list">
            {recent.data?.map((item) => (
              <button
                key={`${item.kind}-${item.id}`}
                type="button"
                className="recent-item"
                onClick={() => navigate(item.kind === 'note' ? `/notes?note=${item.id}` : `/documents?doc=${item.id}`)}
              >
                <span className={`file-glyph ${item.kind === 'note' ? 'file-glyph--note' : ''}`}>
                  {item.kind === 'note' ? <NotebookPen size={16} /> : <FileText size={16} />}
                </span>
                <span className="recent-item__body">
                  <strong>{truncate(item.title, 50)}</strong>
                  <small>{truncate(item.subtitle, 80)}</small>
                </span>
                <span className="recent-item__time">{formatRelative(item.updatedAt)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel model-summary">
          <div className="panel__head">
            <div><span className="eyebrow">本地 RAG</span><h3>知识库状态</h3></div>
            <Badge tone={model.data?.state === 'ready' ? 'success' : model.data?.state === 'error' ? 'danger' : 'neutral'}>
              {model.data?.state === 'ready' ? '就绪' : model.data?.state === 'downloading' ? '下载中' : '待配置'}
            </Badge>
          </div>
          <div className="model-summary__body">
            <div className="model-summary__name">
              <span className="model-orb"><Sparkles size={18} /></span>
              <div>
                <strong>{model.data?.displayName ?? 'multilingual-e5-small'}</strong>
                <span>{model.data?.dimensions ?? 384} 维 · {model.data?.license ?? 'MIT'} · 本地推理</span>
              </div>
            </div>
            <p>
              {data.failedDocuments > 0
                ? `${data.failedDocuments} 个文档索引失败，可到文档阅读页查看原因并重试。`
                : data.indexedDocuments > 0
                  ? `${data.indexedDocuments} 个文档已进入知识库，可以开始资料问答。`
                  : '还没有建立向量索引。添加资料夹并扫描后，在设置中下载模型即可开始。'}
            </p>
          </div>
          <div className="model-summary__actions">
            <Button size="sm" onClick={() => navigate('/settings')}>模型设置</Button>
            <Button size="sm" variant="ghost" onClick={() => navigate('/chat')}>资料问答 <ArrowRight size={13} /></Button>
          </div>
        </section>

        <section className="panel quick-panel">
          <div className="panel__head"><div><span className="eyebrow">快捷入口</span><h3>常用操作</h3></div></div>
          <div className="quick-grid">
            <button type="button" onClick={() => navigate('/folders?new=1')}><FolderOpen size={17} /><span>添加资料夹</span></button>
            <button type="button" onClick={() => navigate('/notes?new=1')}><NotebookPen size={17} /><span>写新笔记</span></button>
            <button type="button" onClick={() => navigate('/tasks?new=1')}><ListTodo size={17} /><span>安排任务</span></button>
            <button type="button" onClick={() => navigate('/websites?new=1')}><Globe2 size={17} /><span>收藏网站</span></button>
          </div>
        </section>
      </div>
    </div>
  )
}
