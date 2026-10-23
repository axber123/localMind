import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe2, GripVertical, Pencil, Plus, Search, Trash2, ExternalLink } from 'lucide-react'
import type { Tag, Website, WebsiteGroup, WebsiteInput } from '../../../../shared/types'
import { unwrap, errorText } from '../../lib/api'
import { hostOf, initialOf } from '../../lib/format'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  TagChip,
  Textarea,
  useToast
} from '../../components/ui'

const EMPTY_FORM: WebsiteInput = { name: '', url: '', description: '', groupId: null, tags: [] }

export function WebsitesPage() {
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [groupId, setGroupId] = useState<number | null>(null)
  const [tagId, setTagId] = useState<number | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Website | null>(null)
  const [form, setForm] = useState<WebsiteInput>(EMPTY_FORM)
  const [tagText, setTagText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Website | null>(null)
  const [groupModal, setGroupModal] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupColor, setGroupColor] = useState('#6366f1')
  const [deletingGroup, setDeletingGroup] = useState<WebsiteGroup | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)

  const websites = useQuery({
    queryKey: ['websites', query, groupId, tagId],
    queryFn: () => unwrap(window.localMind.websites.list({ query, groupId, tagId }))
  })
  const groups = useQuery({ queryKey: ['website-groups'], queryFn: () => unwrap(window.localMind.websites.groups()) })
  const tags = useQuery({ queryKey: ['website-tags'], queryFn: () => unwrap(window.localMind.websites.tags()) })

  useEffect(() => {
    if (params.get('new') === '1') {
      openCreate()
      setParams({}, { replace: true })
    }
  }, [params, setParams])

  const save = useMutation({
    mutationFn: async () => {
      const input: WebsiteInput = {
        ...form,
        tags: tagText.split(',').map((item) => item.trim()).filter(Boolean)
      }
      return editing
        ? unwrap(window.localMind.websites.update(editing.id, input))
        : unwrap(window.localMind.websites.create(input))
    },
    onSuccess: () => {
      toast.success(editing ? '网站已更新' : '网站已添加')
      setModalOpen(false)
      setEditing(null)
      void queryClient.invalidateQueries({ queryKey: ['websites'] })
      void queryClient.invalidateQueries({ queryKey: ['website-tags'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (error) => toast.error('保存失败', errorText(error))
  })

  const remove = useMutation({
    mutationFn: (id: number) => unwrap(window.localMind.websites.remove(id)),
    onSuccess: () => {
      setDeleteTarget(null)
      toast.success('网站已删除')
      void queryClient.invalidateQueries({ queryKey: ['websites'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (error) => toast.error('删除失败', errorText(error))
  })

  const createGroup = useMutation({
    mutationFn: () => unwrap(window.localMind.websites.createGroup(groupName, groupColor)),
    onSuccess: () => {
      setGroupModal(false)
      setGroupName('')
      toast.success('分组已创建')
      void queryClient.invalidateQueries({ queryKey: ['website-groups'] })
    },
    onError: (error) => toast.error('创建分组失败', errorText(error))
  })

  const removeGroup = useMutation({
    mutationFn: (id: number) => unwrap(window.localMind.websites.removeGroup(id)),
    onSuccess: () => {
      setDeletingGroup(null)
      setGroupId(null)
      toast.success('分组已删除，网站已归入未分组')
      void queryClient.invalidateQueries({ queryKey: ['website-groups'] })
      void queryClient.invalidateQueries({ queryKey: ['websites'] })
    },
    onError: (error) => toast.error('删除分组失败', errorText(error))
  })

  const reorder = async (targetId: number): Promise<void> => {
    if (!websites.data || !dragId || dragId === targetId) return
    const ids = websites.data.map((item) => item.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0]!)
    try {
      await unwrap(window.localMind.websites.reorder(ids))
      void queryClient.invalidateQueries({ queryKey: ['websites'] })
    } catch (error) {
      toast.error('排序失败', errorText(error))
    }
  }

  function openCreate(): void {
    setEditing(null)
    setForm(EMPTY_FORM)
    setTagText('')
    setModalOpen(true)
  }

  function openEdit(site: Website): void {
    setEditing(site)
    setForm({
      name: site.name,
      url: site.url,
      description: site.description ?? '',
      groupId: site.groupId,
      tags: site.tags.map((tag) => tag.name)
    })
    setTagText(site.tags.map((tag) => tag.name).join(', '))
    setModalOpen(true)
  }

  const selectedGroup = useMemo(() => groups.data?.find((group) => group.id === groupId), [groups.data, groupId])

  return (
    <div className="page">
      <PageHeader
        title="网站收藏"
        description="把常用学习网站整理成分组，点击卡片用系统浏览器打开。"
        actions={
          <>
            <Button onClick={() => setGroupModal(true)}>新建分组</Button>
            <Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>添加网站</Button>
          </>
        }
      />

      <div className="toolbar">
        <div className="toolbar__search">
          <Search size={15} />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索网站名称、URL 或描述" />
        </div>
        <Select value={groupId ?? ''} onChange={(event) => setGroupId(event.target.value ? Number(event.target.value) : null)}>
          <option value="">全部分组</option>
          {groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </Select>
        <Button variant="ghost" onClick={() => { setQuery(''); setGroupId(null); setTagId(null) }}>重置</Button>
      </div>

      <div className="tag-row">
        <button type="button" className={`filter-pill ${tagId === null ? 'active' : ''}`} onClick={() => setTagId(null)}>全部标签</button>
        {tags.data?.map((tag) => (
          <button
            type="button"
            key={tag.id}
            className={`filter-pill ${tagId === tag.id ? 'active' : ''}`}
            onClick={() => setTagId(tagId === tag.id ? null : tag.id)}
          >
            {tag.name}
          </button>
        ))}
      </div>

      {groupSidebarGroups(groups.data, setDeletingGroup)}

      {websites.isLoading && <Spinner label="加载网站…" />}
      {websites.isError && <ErrorState message={errorText(websites.error)} retry={() => void websites.refetch()} />}
      {websites.data?.length === 0 && (
        <EmptyState
          icon={<Globe2 size={22} />}
          title={query || groupId || tagId ? '没有匹配的网站' : '还没有收藏网站'}
          description="添加 MDN、GitHub、技术博客或课程页面，以后可以更快回到学习现场。"
          action={<Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>添加第一个网站</Button>}
        />
      )}

      <div className="website-grid">
        {websites.data?.map((site) => (
          <article
            key={site.id}
            className="website-card"
            draggable
            onDragStart={() => setDragId(site.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => { void reorder(site.id); setDragId(null) }}
            onClick={() => void openSite(site.id, toast)}
          >
            <div className="website-card__top">
              <div className="website-icon">
                {site.icon ? <img src={site.icon} alt="" /> : <span>{initialOf(site.name)}</span>}
              </div>
              <div className="website-card__actions">
                <span className="drag-handle"><GripVertical size={14} /></span>
                <IconButton label="编辑网站" onClick={(event) => { event.stopPropagation(); openEdit(site) }}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton label="删除网站" onClick={(event) => { event.stopPropagation(); setDeleteTarget(site) }}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </div>
            <div className="website-card__body">
              <h3>{site.name}</h3>
              <span className="website-host">{hostOf(site.url)}</span>
              {site.description && <p>{site.description}</p>}
            </div>
            <div className="website-card__foot">
              <div className="mini-tags">
                {site.groupName && <TagChip name={site.groupName} color={groups.data?.find((group) => group.id === site.groupId)?.color} />}
                {site.tags.slice(0, 3).map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} />)}
              </div>
              <ExternalLink size={13} className="muted" />
            </div>
          </article>
        ))}
      </div>

      {selectedGroup && (
        <div className="inline-note">
          当前分组：{selectedGroup.name}
          <Button size="sm" variant="ghost" onClick={() => setDeletingGroup(selectedGroup)}>删除该分组</Button>
        </div>
      )}

      <Modal open={modalOpen} title={editing ? '编辑网站' : '添加网站'} onClose={() => { setModalOpen(false); setEditing(null) }} description="网站只保存链接，不会在应用内打开。">
        <div className="form-grid">
          <Field label="网站名称">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如 MDN Web Docs" />
          </Field>
          <Field label="URL" hint="必须以 http:// 或 https:// 开头">
            <Input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://developer.mozilla.org" />
          </Field>
          <Field label="分组">
            <Select value={form.groupId ?? ''} onChange={(event) => setForm({ ...form, groupId: event.target.value ? Number(event.target.value) : null })}>
              <option value="">未分组</option>
              {groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </Select>
          </Field>
          <Field label="标签" hint="用英文逗号分隔，最多 12 个">
            <Input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="前端, 文档, 面试" />
          </Field>
          <Field label="描述">
            <Textarea rows={3} value={form.description ?? ''} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="为什么收藏这个网站？" />
          </Field>
        </div>
        <div className="modal__actions">
          <Button onClick={() => setModalOpen(false)}>取消</Button>
          <Button variant="primary" loading={save.isPending} disabled={!form.name.trim() || !form.url.trim()} onClick={() => save.mutate()}>
            保存
          </Button>
        </div>
      </Modal>

      <Modal open={groupModal} title="新建网站分组" onClose={() => setGroupModal(false)}>
        <div className="form-grid">
          <Field label="分组名称">
            <Input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="例如 前端学习" />
          </Field>
          <Field label="颜色">
            <Input type="color" value={groupColor} onChange={(event) => setGroupColor(event.target.value)} />
          </Field>
        </div>
        <div className="modal__actions">
          <Button onClick={() => setGroupModal(false)}>取消</Button>
          <Button variant="primary" loading={createGroup.isPending} disabled={!groupName.trim()} onClick={() => createGroup.mutate()}>创建</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除网站收藏？"
        description={<p>将删除收藏「{deleteTarget?.name}」，不会影响真实网站。此操作不可撤销。</p>}
        confirmLabel="删除"
        danger
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
      <ConfirmDialog
        open={Boolean(deletingGroup)}
        title="删除网站分组？"
        description={<p>分组「{deletingGroup?.name}」会被删除，组内网站会变为未分组，不会被删除。</p>}
        confirmLabel="删除分组"
        danger
        loading={removeGroup.isPending}
        onConfirm={() => deletingGroup && removeGroup.mutate(deletingGroup.id)}
        onClose={() => setDeletingGroup(null)}
      />
    </div>
  )
}

async function openSite(id: number, toast: ReturnType<typeof useToast>): Promise<void> {
  try {
    await unwrap(window.localMind.websites.open(id))
  } catch (error) {
    toast.error('无法打开网站', errorText(error))
  }
}

function groupSidebarGroups(groups: WebsiteGroup[] | undefined, onDelete: (group: WebsiteGroup) => void) {
  if (!groups?.length) return null
  return (
    <div className="group-strip">
      {groups.map((group) => (
        <span className="group-chip" key={group.id} style={{ borderColor: `${group.color}55` }}>
          <i style={{ background: group.color }} />
          {group.name}
          <button type="button" onClick={() => onDelete(group)} aria-label={`删除分组 ${group.name}`}>×</button>
        </span>
      ))}
    </div>
  )
}
