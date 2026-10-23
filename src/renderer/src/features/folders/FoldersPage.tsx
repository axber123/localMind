import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Database,
  FolderOpen,
  FolderPlus,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Trash2
} from 'lucide-react'
import type { Folder, FolderInput } from '../../../../shared/types'
import { unwrap, errorText } from '../../lib/api'
import { formatDate } from '../../lib/format'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  ProgressBar,
  Spinner,
  TagChip,
  Textarea,
  useToast
} from '../../components/ui'

export function FoldersPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [editTarget, setEditTarget] = useState<Folder | null>(null)
  const [note, setNote] = useState('')
  const [tagText, setTagText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Folder | null>(null)

  const folders = useQuery({ queryKey: ['folders'], queryFn: () => unwrap(window.localMind.folders.list()) })
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => unwrap(window.localMind.app.getStats()) })
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => unwrap(window.localMind.indexing.listJobs()) })

  useEffect(() => {
    if (params.get('new') === '1') {
      void addFolder()
      setParams({}, { replace: true })
    }
  }, [params, setParams])

  const activeJob = stats.data?.activeJob
  const filtered = (folders.data ?? []).filter((folder) => {
    const term = query.trim().toLowerCase()
    if (!term) return true
    return folder.name.toLowerCase().includes(term) || folder.path.toLowerCase().includes(term) || (folder.note ?? '').toLowerCase().includes(term)
  })

  async function addFolder(): Promise<void> {
    try {
      const folder = await unwrap(window.localMind.folders.pick())
      if (!folder) return
      toast.success('资料夹已添加', '正在扫描受支持的文档。')
      void queryClient.invalidateQueries({ queryKey: ['folders'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    } catch (error) {
      toast.error('添加资料夹失败', errorText(error))
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!editTarget) throw new Error('缺少资料夹')
      const input: FolderInput = { note, tags: tagText.split(',').map((item) => item.trim()).filter(Boolean) }
      return unwrap(window.localMind.folders.update(editTarget.id, input))
    },
    onSuccess: () => {
      setEditTarget(null)
      toast.success('资料夹信息已更新')
      void queryClient.invalidateQueries({ queryKey: ['folders'] })
    },
    onError: (error) => toast.error('保存失败', errorText(error))
  })

  const action = useMutation({
    mutationFn: async (input: { type: 'scan' | 'index' | 'open' | 'reauthorize'; folder: Folder }) => {
      if (input.type === 'scan') return unwrap(window.localMind.folders.scan(input.folder.id))
      if (input.type === 'index') return unwrap(window.localMind.documents.reindexFolder(input.folder.id))
      if (input.type === 'open') return unwrap(window.localMind.folders.open(input.folder.id))
      return unwrap(window.localMind.folders.reauthorize(input.folder.id))
    },
    onSuccess: (data, variables) => {
      if (variables.type === 'reauthorize' && data === null) return
      if (variables.type === 'scan') toast.info('开始扫描', '扫描进度会显示在页面顶部。')
      if (variables.type === 'index') toast.info('开始建立索引', '本地 Embedding 推理可能需要一些时间。')
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      void queryClient.invalidateQueries({ queryKey: ['folders'] })
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
    },
    onError: (error, variables) => {
      if (variables.type === 'open') {
        void queryClient.invalidateQueries({ queryKey: ['folders'] })
      }
      if (error instanceof Error && error.message.includes('Embedding')) {
        toast.error('索引失败', `${error.message} 请先在设置中下载本地模型。`)
      } else {
        toast.error('操作失败', errorText(error))
      }
    }
  })

  const remove = useMutation({
    mutationFn: (id: number) => unwrap(window.localMind.folders.remove(id, true)),
    onSuccess: () => {
      setDeleteTarget(null)
      toast.success('索引已移除', '原始文件夹和文件没有被删除。')
      void queryClient.invalidateQueries({ queryKey: ['folders'] })
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (error) => toast.error('移除索引失败', errorText(error))
  })

  return (
    <div className="page">
      <PageHeader
        title="我的资料"
        description="添加你授权的本地文件夹。LocalMind 只读取这些目录，移除索引不会删除原始文件。"
        actions={<Button variant="primary" icon={<FolderPlus size={15} />} onClick={() => void addFolder()}>添加文件夹</Button>}
      />

      {activeJob && (
        <section className="panel panel--job">
          <div className="panel__head">
            <div>
              <span className="eyebrow">{activeJob.kind === 'scan' ? '正在扫描' : '正在建立索引'}</span>
              <h3>{activeJob.message ?? '处理中…'}</h3>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void unwrap(window.localMind.indexing.cancel(activeJob.id)).then(() => queryClient.invalidateQueries({ queryKey: ['jobs'] }))}>
              取消任务
            </Button>
          </div>
          <ProgressBar value={activeJob.total ? activeJob.processed / activeJob.total : 0} label={`${activeJob.processed}/${activeJob.total} · ${activeJob.failed} 失败`} />
        </section>
      )}

      <div className="toolbar">
        <div className="toolbar__search">
          <Search size={15} />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件夹名称、路径或备注" />
        </div>
        <Button variant="ghost" onClick={() => void queryClient.invalidateQueries({ queryKey: ['folders'] })}>检查目录状态</Button>
      </div>

      {folders.isLoading && <Spinner label="读取资料夹…" />}
      {folders.isError && <ErrorState message={errorText(folders.error)} retry={() => void folders.refetch()} />}
      {filtered.length === 0 && !folders.isLoading && (
        <EmptyState
          icon={<FolderOpen size={22} />}
          title={query ? '没有匹配的资料夹' : '还没有添加资料夹'}
          description="选择一个你本地保存学习资料的目录。首次添加会扫描文件，但不会上传任何内容。"
          action={<Button variant="primary" icon={<FolderPlus size={15} />} onClick={() => void addFolder()}>选择文件夹</Button>}
        />
      )}

      <div className="folder-list">
        {filtered.map((folder) => (
          <article key={folder.id} className={`folder-card ${folder.isMissing ? 'folder-card--missing' : ''}`}>
            <div className="folder-card__icon"><FolderOpen size={22} /></div>
            <div className="folder-card__body">
              <div className="folder-card__title">
                <h3>{folder.name}</h3>
                {folder.isMissing ? <Badge tone="danger">目录已移动或删除</Badge> : <Badge tone="neutral">本地目录</Badge>}
              </div>
              <button type="button" className="path-button" onClick={() => action.mutate({ type: 'open', folder })} title={folder.path}>{folder.path}</button>
              {folder.note && <p className="folder-note">{folder.note}</p>}
              <div className="folder-meta">
                <span>{folder.documentCount} 个文档</span>
                <span className="ok-text">{folder.indexedCount} 已索引</span>
                {folder.failedCount > 0 && <span className="danger-text">{folder.failedCount} 失败</span>}
                <span>最后检查 {formatDate(folder.lastCheckedAt)}</span>
              </div>
              <div className="mini-tags">
                {folder.tags.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} />)}
              </div>
            </div>
            <div className="folder-card__actions">
              {folder.isMissing ? (
                <Button size="sm" onClick={() => action.mutate({ type: 'reauthorize', folder })}>重新定位</Button>
              ) : (
                <>
                  <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={action.isPending && action.variables?.folder.id === folder.id && action.variables.type === 'scan'} onClick={() => action.mutate({ type: 'scan', folder })}>扫描</Button>
                  <Button size="sm" variant="primary" icon={<Database size={13} />} onClick={() => action.mutate({ type: 'index', folder })}>更新索引</Button>
                </>
              )}
              <IconButton label="打开文件夹" onClick={() => action.mutate({ type: 'open', folder })}><FolderOpen size={15} /></IconButton>
              <IconButton label="编辑资料夹" onClick={() => { setEditTarget(folder); setNote(folder.note ?? ''); setTagText(folder.tags.map((tag) => tag.name).join(', ')) }}><Pencil size={15} /></IconButton>
              <IconButton label="移除索引" onClick={() => setDeleteTarget(folder)}><Trash2 size={15} /></IconButton>
            </div>
          </article>
        ))}
      </div>

      <section className="panel">
        <div className="panel__head">
          <div><span className="eyebrow">任务历史</span><h3>最近的扫描与索引</h3></div>
          <Button size="sm" variant="ghost" onClick={() => navigate('/documents')}>查看文档</Button>
        </div>
        {jobs.data?.length === 0 && <div className="soft-empty">还没有扫描任务。添加资料夹后会自动扫描一次。</div>}
        <div className="job-list">
          {jobs.data?.slice(0, 8).map((job) => (
            <div key={job.id} className="job-item">
              <span className={`job-dot job-dot--${job.status}`} />
              <div><strong>{job.kind === 'scan' ? '扫描资料夹' : '建立知识库索引'}</strong><span>{job.message ?? job.error ?? '—'}</span></div>
              <span className="muted">{job.total ? `${job.processed}/${job.total}` : ''}</span>
              <Badge tone={job.status === 'failed' ? 'danger' : job.status === 'completed' ? 'success' : 'info'}>{job.status}</Badge>
            </div>
          ))}
        </div>
      </section>

      <Modal open={Boolean(editTarget)} title="编辑资料夹" description={editTarget?.path} onClose={() => setEditTarget(null)}>
        <div className="form-grid">
          <Field label="备注"><Textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="这组资料主要学什么？" /></Field>
          <Field label="标签" hint="用英文逗号分隔"><Input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="JavaScript, 面试" /></Field>
        </div>
        <div className="modal__actions">
          <Button onClick={() => setEditTarget(null)}>取消</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>保存</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="移除这个资料夹的索引？"
        description={
          <div className="consent-copy">
            <p>将删除 LocalMind 数据库中的文档元数据、全文索引和向量索引。</p>
            <p><strong>不会删除原始文件夹或任何原始文件。</strong></p>
            <p>以后需要时可以重新添加并扫描：{deleteTarget?.path}</p>
          </div>
        }
        confirmLabel="仅移除索引"
        danger
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}
