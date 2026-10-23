import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Bot,
  BookOpen,
  BrainCircuit,
  ChevronDown,
  FolderOpen,
  Globe2,
  Home,
  ListTodo,
  Loader2,
  NotebookPen,
  Plus,
  Search,
  Settings,
  Sparkles
} from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { unwrap } from '../lib/api'
import { useUiStore } from '../store/ui'
import { useToast, Button, IconButton } from './ui'
import { QuickAssistant } from './QuickAssistant'

const NAV = [
  { to: '/', label: '首页', icon: Home, end: true },
  { to: '/websites', label: '网站收藏', icon: Globe2 },
  { to: '/folders', label: '我的资料', icon: FolderOpen },
  { to: '/documents', label: '文档阅读', icon: BookOpen },
  { to: '/notes', label: '我的笔记', icon: NotebookPen },
  { to: '/chat', label: 'AI 助手', icon: Bot },
  { to: '/tasks', label: '学习计划', icon: ListTodo }
]

function modelLabel(state: string | undefined): string {
  switch (state) {
    case 'ready':
      return '本地模型就绪'
    case 'loading':
      return '模型加载中'
    case 'downloading':
      return '模型下载中'
    case 'error':
      return '模型异常'
    default:
      return '模型未安装'
  }
}

function EventBridge() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const terminalJobs = useRef(new Set<string>())
  const lastModelState = useRef<string | null>(null)

  useEffect(() => {
    const offIndex = window.localMind.indexingEvents.onProgress((event) => {
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      void queryClient.invalidateQueries({ queryKey: ['folders'] })
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
      if (['completed', 'failed', 'cancelled'].includes(event.status) && !terminalJobs.current.has(event.jobId)) {
        terminalJobs.current.add(event.jobId)
        if (event.status === 'failed') toast.error('索引任务失败', event.message ?? undefined)
        else if (event.status === 'cancelled') toast.info('任务已取消')
        else toast.success(event.kind === 'scan' ? '扫描完成' : '索引完成', event.message ?? undefined)
        void queryClient.invalidateQueries({ queryKey: ['recent'] })
        void queryClient.invalidateQueries({ queryKey: ['notes'] })
      }
    })
    const offModel = window.localMind.modelEvents.onProgress((event) => {
      void queryClient.invalidateQueries({ queryKey: ['model'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      if (event.state === 'error' && lastModelState.current !== 'error') {
        toast.error('本地模型异常', event.message ?? '请到设置中重试。')
      }
      lastModelState.current = event.state
    })
    return () => {
      offIndex()
      offModel()
    }
  }, [queryClient, toast])

  return null
}

function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const toast = useToast()

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(query.trim()), 220)
    return () => window.clearTimeout(timeout)
  }, [query])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const results = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: () => unwrap(window.localMind.search.global(debounced)),
    enabled: debounced.length > 0
  })

  const openHit = async (hit: NonNullable<typeof results.data>['groups'][number]['hits'][number]): Promise<void> => {
    setOpen(false)
    if (hit.type === 'website') {
      try {
        await unwrap(window.localMind.websites.open(hit.id))
      } catch (error) {
        toast.error('无法打开网站', error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (hit.type === 'folder') navigate('/folders')
    if (hit.type === 'document') navigate(`/documents?doc=${hit.id}`)
    if (hit.type === 'note') navigate(`/notes?note=${hit.id}`)
    if (hit.type === 'chat') navigate(`/chat?chat=${hit.id}`)
  }

  return (
    <div className="global-search">
      <Search size={16} className="global-search__icon" />
      <input
        ref={inputRef}
        value={query}
        placeholder="搜索网站、文档、笔记、聊天…  Ctrl+K"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && query.trim()) {
            navigate(`/search?q=${encodeURIComponent(query.trim())}`)
            setOpen(false)
          }
        }}
      />
      {open && query.trim() && (
        <>
          <div className="search-backdrop" onClick={() => setOpen(false)} />
          <div className="search-popover">
            {results.isLoading && <div className="search-status"><Loader2 className="spin" size={15} /> 正在搜索…</div>}
            {results.data && results.data.total === 0 && <div className="search-status">没有找到相关内容</div>}
            {results.data?.groups.map((group) => (
              <div className="search-group" key={group.type}>
                <span className="search-group__label">{group.label}</span>
                {group.hits.map((hit) => (
                  <button key={`${hit.type}-${hit.id}`} type="button" className="search-hit" onClick={() => void openHit(hit)}>
                    <span>{hit.title}</span>
                    <small>{hit.snippet ?? hit.subtitle}</small>
                  </button>
                ))}
              </div>
            ))}
            {results.data && results.data.total > 0 && (
              <button
                type="button"
                className="search-all"
                onClick={() => {
                  navigate(`/search?q=${encodeURIComponent(query.trim())}`)
                  setOpen(false)
                }}
              >
                查看全部结果
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function NewMenu() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const options = [
    { label: '新建网站', to: '/websites?new=1' },
    { label: '新建笔记', to: '/notes?new=1' },
    { label: '新建学习任务', to: '/tasks?new=1' },
    { label: '新建 AI 对话', to: '/chat?new=1' }
  ]
  return (
    <div className="new-menu">
      <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setOpen((value) => !value)}>
        新建
        <ChevronDown size={13} />
      </Button>
      {open && (
        <>
          <div className="new-menu__backdrop" onClick={() => setOpen(false)} />
          <div className="new-menu__popover">
            {options.map((option) => (
              <button
                key={option.to}
                type="button"
                onClick={() => {
                  setOpen(false)
                  navigate(option.to)
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function Layout() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => unwrap(window.localMind.app.getStats()) })
  const { aiOpen, toggleAi } = useUiStore()
  const location = useLocation()
  const navigate = useNavigate()
  const modelState = stats.data?.modelState
  const activeJob = stats.data?.activeJob

  return (
    <div className={`app-shell ${aiOpen ? 'app-shell--ai' : ''}`}>
      <EventBridge />
      <aside className="sidebar">
        <div className="brand" onClick={() => navigate('/')}>
          <div className="brand__mark">
            <BrainCircuit size={20} />
          </div>
          <div>
            <strong>LocalMind</strong>
            <span>本地知识助手</span>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav__item ${isActive ? 'nav__item--active' : ''}`}
            >
              <item.icon size={17} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__bottom">
          <NavLink to="/settings" className={({ isActive }) => `nav__item ${isActive ? 'nav__item--active' : ''}`}>
            <Settings size={17} />
            <span>设置</span>
          </NavLink>
          <div className="privacy-note">
            <Sparkles size={14} />
            <span>资料留在本地 · 检索在本地</span>
          </div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <GlobalSearch />
          <div className="topbar__actions">
            <NewMenu />
            <button
              type="button"
              className={`status-chip status-chip--${modelState === 'ready' ? 'ok' : modelState === 'error' ? 'danger' : 'warn'}`}
              onClick={() => navigate('/settings')}
              title="打开模型设置"
            >
              <span className="status-dot" />
              {modelLabel(modelState)}
            </button>
            {activeJob && (
              <button type="button" className="status-chip status-chip--busy" onClick={() => navigate('/folders')}>
                <Loader2 size={13} className="spin" />
                {activeJob.kind === 'scan' ? '扫描中' : '索引中'} {activeJob.processed}/{activeJob.total || '?'}
              </button>
            )}
            <IconButton label={aiOpen ? '收起 AI 面板' : '展开 AI 面板'} onClick={toggleAi} className={aiOpen ? 'active' : ''}>
              <Bot size={17} />
            </IconButton>
          </div>
        </header>
        <div className="workspace-row">
          <main className="workspace" key={location.pathname}>
            <Outlet />
          </main>
          <QuickAssistant />
        </div>
      </div>
    </div>
  )
}
