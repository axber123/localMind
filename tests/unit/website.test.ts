import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/db/database'
import { WebsiteService } from '../../src/main/services/websiteService'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('WebsiteService CRUD', () => {
  it('creates, edits, reorders and deletes websites with tags and groups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'localmind-website-'))
    dirs.push(dir)
    const db = new AppDatabase(join(dir, 'app.db'))
    const service = new WebsiteService(db)
    const group = service.createGroup('前端', '#6366f1')
    const first = service.create({ name: 'MDN', url: 'https://developer.mozilla.org', tags: ['文档'], groupId: group.id })
    const second = service.create({ name: 'Vue', url: 'https://vuejs.org', tags: ['前端'] })
    expect(service.list({ groupId: null })).toHaveLength(2)
    const updated = service.update(second.id, {
      name: 'Vue 3',
      url: 'https://vuejs.org/guide/',
      description: '渐进式框架',
      groupId: group.id,
      tags: ['前端', '框架']
    })
    expect(updated.name).toBe('Vue 3')
    expect(updated.groupId).toBe(group.id)
    expect(updated.tags.map((tag) => tag.name).sort()).toEqual(['前端', '框架'])
    service.reorder([second.id, first.id])
    expect(service.list().map((site) => site.name)).toEqual(['Vue 3', 'MDN'])
    service.remove(second.id)
    expect(service.list().map((site) => site.name)).toEqual(['MDN'])
    service.removeGroup(group.id)
    expect(service.list()[0]?.groupId).toBeNull()
    db.close()
  })
})
