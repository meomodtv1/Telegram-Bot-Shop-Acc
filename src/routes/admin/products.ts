```ts
import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import type { DbProduct, DbProductType } from '../../types/db'

type AdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

const productRoutes = new Hono<AdminEnv>()

// All routes require JWT authentication
productRoutes.use('/*', jwtAuth)

/**
 * GET /products
 * List products with pagination, filter by type_id and status.
 */
productRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20))
  const offset = (page - 1) * limit

  const typeId = c.req.query('filter[type_id]') || c.req.query('type_id')
  const status = c.req.query('filter[status]') || c.req.query('status')
  const sort = c.req.query('sort') || 'created_at'
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC'

  const allowedSorts = ['id', 'created_at', 'sold_at', 'status', 'type_id']
  const safeSort = allowedSorts.includes(sort) ? sort : 'created_at'

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (typeId) {
    conditions.push('p.type_id = ?')
    params.push(Number(typeId))
  }

  if (status && ['available', 'sold', 'reserved'].includes(status)) {
    conditions.push('p.status = ?')
    params.push(status)
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : ''

  const countSql = `SELECT COUNT(*) as total FROM products p ${whereClause}`
  const countResult = await c.env.DB.prepare(countSql)
    .bind(...params)
    .first<{ total: number }>()

  const total = countResult?.total ?? 0

  const dataSql = `
    SELECT p.id, p.type_id, p.content, p.status, p.buyer_id, p.order_id,
           p.created_at, p.sold_at, pt.name as type_name
    FROM products p
    LEFT JOIN product_types pt ON p.type_id = pt.id
    ${whereClause}
    ORDER BY p.${safeSort} ${order}
    LIMIT ? OFFSET ?
  `

  const dataParams = [...params, limit, offset]
  const { results } = await c.env.DB.prepare(dataSql)
    .bind(...dataParams)
    .all()

  return c.json({
    success: true,
    data: results,
    error: null,
    meta: { total, page, limit },
  })
})

/**
 * POST /products/import
 * Import products in bulk.
 * Automatically notify active Telegram users when new products are imported.
 */
productRoutes.post('/import', async (c) => {
  const body = await c.req.json<{
    category_id?: number
    contents?: string[]
  }>()

  if (
    !body.category_id ||
    !Array.isArray(body.contents) ||
    body.contents.length === 0
  ) {
    return c.json(
      {
        success: false,
        data: null,
        error: 'category_id and non-empty contents[] are required',
      },
      400
    )
  }

  const { category_id, contents } = body

  // Verify category exists
  const category = await c.env.DB.prepare(
    'SELECT id FROM product_types WHERE id = ?'
  )
    .bind(category_id)
    .first<Pick<DbProductType, 'id'>>()

  if (!category) {
    return c.json(
      { success: false, data: null, error: 'Category not found' },
      404
    )
  }

  // Remove empty contents
  const validContents = contents
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (validContents.length === 0) {
    return c.json(
      { success: false, data: null, error: 'No valid contents provided' },
      400
    )
  }

  // Check duplicate products
  const placeholders = validContents.map(() => '?').join(', ')
  const existingQuery = `
    SELECT content
    FROM products
    WHERE type_id = ? AND content IN (${placeholders})
  `

  const existingParams = [category_id, ...validContents]

  const { results: existingProducts } = await c.env.DB.prepare(existingQuery)
    .bind(...existingParams)
    .all<{ content: string }>()

  const existingSet = new Set(existingProducts.map((p) => p.content))

  const duplicates: string[] = []
  const toInsert: string[] = []

  for (const content of validContents) {
    if (existingSet.has(content)) {
      duplicates.push(content)
    } else if (toInsert.includes(content)) {
      duplicates.push(content)
    } else {
      toInsert.push(content)
    }
  }

  const errors: string[] = []
  let imported = 0

  // Insert new products
  if (toInsert.length > 0) {
    const now = new Date().toISOString()

    const stmts = toInsert.map((content) =>
      c.env.DB.prepare(
        `INSERT INTO products
         (type_id, content, status, created_at)
         VALUES (?, ?, ?, ?)`
      ).bind(category_id, content, 'available', now)
    )

    try {
      const results = await c.env.DB.batch(stmts)
      imported = results.filter((r) => r.meta.changes > 0).length
    } catch (err: unknown) {
      const message = err instanceof Error
        ? err.message
        : 'Unknown database error'

      errors.push(message)
    }
  }

  // Log audit
  const adminId = c.get('adminId')

  await c.env.DB.prepare(
    `INSERT INTO audit_logs
     (admin_id, action, resource_type, resource_id, new_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      adminId,
      'import',
      'product',
      category_id,
      JSON.stringify({
        imported,
        duplicates: duplicates.length,
        errors: errors.length,
      }),
      new Date().toISOString()
    )
    .run()

  // ==========================================
  // AUTOMATIC TELEGRAM PRODUCT NOTIFICATION
  // Only send when new products were imported
  // ==========================================
  let notificationsSent = 0
  let notificationsFailed = 0

  if (imported > 0) {
    try {
      const categoryInfo = await c.env.DB.prepare(
        'SELECT name FROM product_types WHERE id = ?'
      )
        .bind(category_id)
        .first<{ name: string }>()

      const categoryName = categoryInfo?.name || 'Sản phẩm mới'

      const message =
        `📢 SHOP VỪA CẬP NHẬT HÀNG MỚI\n\n` +
        `📦 Danh mục: ${categoryName}\n` +
        `✨ Kho vừa bổ sung ${imported} sản phẩm mới.\n\n` +
        `🛒 Sản phẩm hiện đã sẵn sàng.\n` +
        `👉 Truy cập bot và chọn Mua hàng để xem.\n\n` +
        `💎 Cảm ơn bạn đã tin tưởng shop!`

      let offset = 0
      const batchSize = 100

      while (true) {
        const users = await c.env.DB.prepare(
          `SELECT telegram_id
           FROM users
           WHERE is_active = 1
           ORDER BY id
           LIMIT ? OFFSET ?`
        )
          .bind(batchSize, offset)
          .all<{ telegram_id: number }>()

        if (users.results.length === 0) {
          break
        }

        for (const user of users.results) {
          try {
            const response = await fetch(
              `https://api.telegram.org/bot${c.env.BOT_TOKEN}/sendMessage`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  chat_id: user.telegram_id,
                  text: message,
                }),
              }
            )

            const result = await response.json() as {
              ok?: boolean
              description?: string
            }

            if (response.ok && result.ok) {
              notificationsSent++
            } else {
              notificationsFailed++
              console.error(
                'Telegram notification rejected:',
                result.description || response.status
              )
            }
          } catch (notifyError) {
            notificationsFailed++
            console.error(
              'Telegram notification failed:',
              notifyError
            )
          }

          // Avoid sending messages too quickly
          await new Promise((resolve) => setTimeout(resolve, 40))
        }

        offset += users.results.length

        if (users.results.length < batchSize) {
          break
        }
      }
    } catch (notifyError) {
      console.error('Product notification error:', notifyError)
    }
  }

  return c.json({
    success: true,
    data: {
      imported,
      duplicates,
      errors,
      notifications: {
        sent: notificationsSent,
        failed: notificationsFailed,
      },
    },
    error: null,
  })
})

/**
 * DELETE /products/:id
 * Only allow deleting products with status='available'.
 */
productRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))

  if (!id || isNaN(id)) {
    return c.json(
      { success: false, data: null, error: 'Invalid product ID' },
      400
    )
  }

  // Find product
  const product = await c.env.DB.prepare(
    'SELECT id, type_id, content, status FROM products WHERE id = ?'
  )
    .bind(id)
    .first<Pick<DbProduct, 'id' | 'type_id' | 'content' | 'status'>>()

  if (!product) {
    return c.json(
      { success: false, data: null, error: 'Product not found' },
      404
    )
  }

  if (product.status !== 'available') {
    return c.json(
      {
        success: false,
        data: null,
        error: `Cannot delete product with status '${product.status}'. Only 'available' products can be deleted.`,
      },
      400
    )
  }

  // Delete product
  await c.env.DB.prepare(
    'DELETE FROM products WHERE id = ?'
  )
    .bind(id)
    .run()

  // Log audit
  const adminId = c.get('adminId')

  await c.env.DB.prepare(
    `INSERT INTO audit_logs
     (admin_id, action, resource_type, resource_id, old_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      adminId,
      'delete',
      'product',
      id,
      JSON.stringify({
        type_id: product.type_id,
        content: product.content,
      }),
      new Date().toISOString()
    )
    .run()

  return c.json({
    success: true,
    data: { id },
    error: null,
  })
})

export { productRoutes }
```
