import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import hljs from 'highlight.js/lib/common'
import python from 'highlight.js/lib/languages/python'
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  FileText,
  FolderOpen,
  RefreshCw,
  Search
} from 'lucide-react'
import type { IndexStatus } from '../../../../shared/types'
import { unwrap, errorText } from '../../lib/api'
import { formatBytes, formatDate, statusLabel } from '../../lib/format'
import { useUiStore } from '../../store/ui'
import { Badge, Button, EmptyState, ErrorState, Input, PageHeader, Select, Spinner, useToast } from '../../components/ui'

hljs.registerLanguage('python', python)

const PAGE_SIZE = 40

export function DocumentsPage() {
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const toast = useToast()
  const setAiScope = useUiStore((state) => state.setAiScope)
  const [query, setQuery] = useState('')
  const [folderId, setFolderId] = useState<number | null>(null)
  const [status, setStatus] = useState<IndexStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const selectedId = params.get('doc') ? Number(params.get('doc')) : null
  const offset = Number(params.get('offset') ?? 0)
  const contentRef = useRef<HTMLPreElement>(null)

  const folders = useQuery({ queryKey: ['folders'], queryFn: () => unwrap(window.localMind.folders.list()) })
  const documents = useQuery({
    queryKey: ['documents', query, folderId, status, page],
    queryFn: () => unwrap(window.localMind.documents.list({ query, folderId, status, page, pageSize: PAGE_SIZE }))
  })
  const preview = useQuery({
    queryKey: ['document-preview', selectedId],
    queryFn: () => unwrap(window.localMind.documents.preview(selectedId!)),
    enabled: Boolean(selectedId)
  })

  useEffect(() => {
    if (!selectedId && documents.data?.items[0]) {
      setParams({ doc: String(documents.data.items[0].id) }, { replace: true })
    }
  }, [documents.data, selectedId, setParams])

  useEffect(() => {
    if (!preview.data || !offset || !contentRef.current) return
    const line = preview.data.content.slice(0, offset).split('\n').length
    const lineHeight = 21
    contentRef.current.parentElement?.scrollTo({ top: Math.max(0, (line - 3) * lineHeight), behavior: 'smooth' })
  }, [preview.data, offset])

  const html = useMemo(() => {
    if (!preview.data) return ''
    try {
      const language = preview.data.language
      return language && hljs.getLanguage(language)
        ? hljs.highlight(preview.data.content, { language }).value
        : hljs.highlightAuto(preview.data.content).value
    } catch {
      return preview.data.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [preview.data])

  const indexSelected = async (): Promise<void> => {
    if (!selectedId) return
    try {
      await unwrap(window.localMind.documents.indexOne(selectedId))
      toast.info('已开始建立索引', '完成后会显示在文档状态中。')
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
      void queryClient.invalidateQueries({ queryKey: ['document-preview', selectedId] })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    } catch (error) {
      toast.error('索引失败', errorText(error))
    }
  }

  const totalPages = documents.data ? Math.max(1, Math.ceil(documents.data.total / PAGE_SIZE)) : 1

  return (
    <div className="page page--documents">
      <PageHeader
        title="文档阅读"
        description="浏览已扫描的本地文档。打开文档后可以让 AI 基于当前文档回答问题。"
        actions={<Button variant="ghost" icon={<FolderOpen size={15} />} onClick={() => void queryClient.invalidateQueries({ queryKey: ['folders'] })}>检查资料夹</Button>}
      />
      <div className="toolbar">
        <div className="toolbar__search">
          <Search size={15} />
          <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="搜索文件名或已索引内容" />
        </div>
        <Select value={folderId ?? ''} onChange={(event) => { setFolderId(event.target.value ? Number(event.target.value) : null); setPage(1) }}>
          <option value="">全部资料夹</option>
          {folders.data?.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </Select>
        <Select value={status} onChange={(event) => { setStatus(event.target.value as IndexStatus | 'all'); setPage(1) }}>
          <option value="all">全部状态</option>
          <option value="indexed">已索引</option>
          <option value="pending">待索引</option>
          <option value="failed">失败</option>
          <option value="processing">处理中</option>
        </Select>
      </div>

      <div className="document-layout">
        <section className="doc-list-panel">
          <div className="doc-list-head">
            <span>{documents.data?.total ?? 0} 个文档</span>
            <div className="pager">
              <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={14} /></button>
              <span>{page}/{totalPages}</span>
              <button type="button" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={14} /></button>
            </div>
          </div>
          <div className="doc-list">
            {documents.isLoading && <Spinner label="扫描文档列表…" />}
            {documents.isError && <ErrorState message={errorText(documents.error)} retry={() => void documents.refetch()} />}
            {documents.data?.items.length === 0 && (
              <EmptyState icon={<FileText size={22} />} title="没有找到文档" description="先在“我的资料”中添加文件夹并扫描。" />
            )}
            {documents.data?.items.map((doc) => (
              <button
                type="button"
                key={doc.id}
                className={`doc-row ${selectedId === doc.id ? 'doc-row--active' : ''}`}
                onClick={() => setParams({ doc: String(doc.id) })}
              >
                <span className={`doc-file-icon ext-${doc.extension.replace('.', '')}`}><FileText size={15} /></span>
                <span className="doc-row__body">
                  <strong>{doc.fileName}</strong>
                  <small>{doc.folderName ?? '资料夹'} · {formatBytes(doc.fileSize)}</small>
                </span>
                <Badge tone={doc.indexingStatus === 'indexed' ? 'success' : doc.indexingStatus === 'failed' ? 'danger' : 'neutral'}>
                  {statusLabel(doc.indexingStatus)}
                </Badge>
              </button>
            ))}
          </div>
        </section>

        <section className="doc-preview-panel">
          {!selectedId && <EmptyState icon={<FileText size={22} />} title="选择一个文档" description="左侧选择文档查看内容。" />}
          {selectedId && preview.isLoading && <Spinner label="读取文档…" />}
          {selectedId && preview.isError && <ErrorState message={errorText(preview.error)} retry={() => void preview.refetch()} />}
          {preview.data && (
            <>
              <div className="doc-preview-head">
                <div>
                  <h2>{preview.data.document.fileName}</h2>
                  <p>{preview.data.document.sourcePath}</p>
                </div>
                <div className="doc-preview-actions">
                  <Badge tone={preview.data.document.indexingStatus === 'indexed' ? 'success' : preview.data.document.indexingStatus === 'failed' ? 'danger' : 'neutral'}>
                    {statusLabel(preview.data.document.indexingStatus)}
                  </Badge>
                  <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => void navigator.clipboard.writeText(preview.data!.content)}>复制</Button>
                  <Button size="sm" onClick={() => void indexSelected()} icon={<Database size={13} />}>索引本文档</Button>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Bot size={13} />}
                    onClick={() => setAiScope({ documentIds: [preview.data.document.id] }, preview.data.document.fileName)}
                  >
                    问 AI
                  </Button>
                </div>
              </div>
              <div className="doc-info-strip">
                <span>{preview.data.lineCount} 行</span>
                <span>{formatBytes(preview.data.totalBytes)}</span>
                <span>修改于 {formatDate(preview.data.document.lastModifiedAt)}</span>
                <span>{preview.data.chunkCount} 个知识库片段</span>
                {preview.data.document.isStale && <Badge tone="danger">索引需重建</Badge>}
                {preview.data.truncated && <Badge tone="info">仅显示前 2 MB</Badge>}
              </div>
              {preview.data.document.errorMessage && <div className="inline-error">{preview.data.document.errorMessage}</div>}
              <div className="doc-content">
                <pre ref={contentRef}><code className={`hljs language-${preview.data.language}`} dangerouslySetInnerHTML={{ __html: html }} /></pre>
              </div>
              <div className="doc-preview-foot">
                <span>只读取已授权资料夹内的文件。</span>
                <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void preview.refetch()}>重新读取</Button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
