import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bot, FileText, FolderOpen, Globe2, NotebookPen, Search } from 'lucide-react'
import type { SearchHit } from '../../../../shared/types'
import { errorText, unwrap } from '../../lib/api'
import { Button, EmptyState, ErrorState, Input, PageHeader, Spinner, useToast } from '../../components/ui'

const ICONS = {
  website: Globe2,
  folder: FolderOpen,
  document: FileText,
  note: NotebookPen,
  chat: Bot
}

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const initial = params.get('q') ?? ''
  const [input, setInput] = useState(initial)
  const query = params.get('q')?.trim() ?? ''
  const results = useQuery({
    queryKey: ['search-page', query],
    queryFn: () => unwrap(window.localMind.search.global(query)),
    enabled: Boolean(query)
  })

  const openHit = async (hit: SearchHit): Promise<void> => {
    if (hit.type === 'website') {
      try {
        await unwrap(window.localMind.websites.open(hit.id))
      } catch (error) {
        toast.error('无法打开网站', errorText(error))
      }
      return
    }
    if (hit.type === 'folder') navigate('/folders')
    if (hit.type === 'document') navigate(`/documents?doc=${hit.id}`)
    if (hit.type === 'note') navigate(`/notes?note=${hit.id}`)
    if (hit.type === 'chat') navigate(`/chat?chat=${hit.id}`)
  }

  return (
    <div className="page">
      <PageHeader title="全局搜索" description="在网站、文件夹、文档、笔记和聊天历史中搜索。" />
      <div className="search-page-form">
        <Search size={18} />
        <Input
          autoFocus
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setParams({ q: input.trim() })
          }}
          placeholder="输入关键词，按 Enter 搜索"
        />
        <Button variant="primary" onClick={() => setParams({ q: input.trim() })}>搜索</Button>
      </div>
      {!query && <EmptyState icon={<Search size={22} />} title="输入关键词开始搜索" description="中文和英文关键词都支持。文档正文搜索需要先扫描资料夹。" />}
      {query && results.isLoading && <Spinner label="搜索中…" />}
      {query && results.isError && <ErrorState message={errorText(results.error)} retry={() => void results.refetch()} />}
      {query && results.data?.total === 0 && <EmptyState icon={<Search size={22} />} title="没有找到相关内容" description="试试更短的关键词，或先扫描资料夹建立全文索引。" />}
      {results.data?.groups.map((group) => (
        <section className="panel" key={group.type}>
          <div className="panel__head"><div><span className="eyebrow">{group.label}</span><h3>{group.hits.length} 条结果</h3></div></div>
          <div className="search-results">
            {group.hits.map((hit) => {
              const Icon = ICONS[hit.type]
              return (
                <button type="button" key={`${hit.type}-${hit.id}`} onClick={() => void openHit(hit)} className="search-result">
                  <span className="search-result__icon"><Icon size={17} /></span>
                  <span>
                    <strong>{hit.title}</strong>
                    {hit.subtitle && <small>{hit.subtitle}</small>}
                    {hit.snippet && <p>{hit.snippet}</p>}
                  </span>
                  <em>{hit.meta}</em>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
