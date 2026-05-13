// server.js
require('dotenv').config(); // 🌟 必须放在最顶端！用来读取 .env 文件里的隐藏配置
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(cors()); // 允许跨域请求
app.use(express.json());

// 1. 配置数据库连接 (专业脱敏版：动态读取环境变量)
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ====== 测试数据库连接 ======
pool.getConnection()
    .then(connection => {
        console.log('✅ 数据库连接成功！');
        connection.release();
    })
    .catch(err => {
        console.error('❌ 数据库连接失败：', err.message);
    });

// 健康检查接口，专门给 UptimeRobot 敲门用
app.get('/', (req, res) => {
    res.status(200).send('API is awake and running!');
});


// 2. 获取购物车列表接口
app.get('/api/cart/:consumerId', async (req, res) => {
    const { consumerId } = req.params;
    try {
        // 🚨 修正：shopcar -> shopping_cart，更新相应的字段名
        const [rows] = await pool.query(`
            SELECT
                sc.cart_id AS cart_id,
                sc.quantity AS quantity,    -- 🌟 终于可以使用真实的库存数量了！
                b.book_id AS book_id,
                b.book_name AS book_name,
                b.author,
                b.price,
                b.quality
            FROM shopping_cart sc
                     JOIN book b ON sc.book_id = b.book_id
            WHERE sc.consumer_id = ?
            ORDER BY sc.cart_id DESC
        `, [consumerId]);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 🌟 补充丢失的接口：修改/删除购物车商品 (PUT)
app.put('/api/cart/:cartId', async (req, res) => {
    const { quantity } = req.body;
    try {
        if (quantity <= 0) {
            // 数量减到0或以下，直接从购物车删除
            await pool.query('DELETE FROM shopping_cart WHERE cart_id = ?', [req.params.cartId]);
        } else {
            // 更新数量
            await pool.query('UPDATE shopping_cart SET quantity = ? WHERE cart_id = ?', [quantity, req.params.cartId]);
        }
        res.json({ success: true, message: '数量已更新' });
    } catch (error) {
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 4. 获取图书列表 (适配你的数据库字段：quality, categoryname)
app.get('/api/books', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const offset = (page - 1) * limit;

    const keyword = req.query.keyword;
    const category = req.query.category;

    try {
        // 🌟 核心修复 1：加上 stock >= 0 的条件。结合连表查询获取 category_name
        let baseSql = ` FROM book b LEFT JOIN category c ON b.category_id = c.category_id WHERE b.stock >= 0 `;
        let params = [];

        if (keyword) {
            baseSql += ` AND (b.book_name LIKE ? OR b.author LIKE ?)`;
            params.push(`%${keyword}%`, `%${keyword}%`);
        }

        if (category && category !== 'All') {
            baseSql += ` AND c.category_name = ?`;
            params.push(category);
        }

        const [countResult] = await pool.query(`SELECT COUNT(*) as total ${baseSql}`, params);
        const total = countResult[0].total;

        // 🌟 核心修复 2：更新字段名，依然输出前端需要的别名
        const dataSql = `
            SELECT 
                b.book_id AS book_id, 
                b.book_name AS book_name, 
                b.author, 
                b.isbn, 
                c.category_name AS category_name, 
                b.quality, 
                b.price, 
                b.stock     -- 👈 这里不再写死 50，直接读取真实库存
            ${baseSql} ORDER BY b.book_id DESC LIMIT ? OFFSET ?
        `;
        const [rows] = await pool.query(dataSql, [...params, limit, offset]);

        res.json({
            success: true,
            data: rows,
            total: total,
            currentPage: page,
            totalPages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('Store API Error:', error);
        res.status(500).json({ success: false, message: '服务器查询失败' });
    }
});

// ====== 在 server.js 里面追加这段 ======

// 5. 加入购物车接口 (POST 请求)
app.post('/api/cart', async (req, res) => {
    // 前端传过来的是带有下划线的变量
    const { consumer_id, book_id } = req.body;

    try {
        // 🚨 修正1：表名改为 shopping_cart，字段名对齐新库
        const [exist] = await pool.query(
            'SELECT cart_id FROM shopping_cart WHERE consumer_id = ? AND book_id = ?',
            [consumer_id, book_id]
        );

        if (exist.length > 0) {
            // 如果已经有了，数量直接 +1
            await pool.query(
                'UPDATE shopping_cart SET quantity = quantity + 1 WHERE cart_id = ?',
                [exist[0].cart_id]
            );
        } else {
            // 🚨 修正2：往 shopping_cart 表里插入数据
            await pool.query(
                'INSERT INTO shopping_cart (consumer_id, book_id, quantity) VALUES (?, ?, 1)',
                [consumer_id, book_id]
            );
        }
        res.json({ success: true, message: 'Successfully added to cart!' });
    } catch (error) {
        console.error('加购崩溃了:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


// ====== 在 server.js 里面追加这段 ======

// 核心：结算下单 (POST)
app.post('/api/checkout', async (req, res) => {
    // 前端发过来的变量名带有下划线，这个我们接收即可
    const { consumer_id } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 🚨 修正1：查用户信息，字段对齐新表 consumer_id 和 vip_level
        const [user] = await connection.query(
            'SELECT vip_level FROM consumer WHERE consumer_id = ?',
            [consumer_id]
        );
        const level = user[0]?.vip_level || 0;

        // 折扣逻辑不变
        let discountRate = 1.0;
        if (level === 1) discountRate = 0.95; // 银卡 95折
        else if (level === 2) discountRate = 0.90; // 金卡 90折
        else if (level === 3) discountRate = 0.85; // 钻石 85折

        // 🚨 修正2：查购物车，表名为 shopping_cart，字段为 consumer_id, book_id
        const [cartItems] = await connection.query(`
            SELECT sc.book_id, sc.quantity, b.price
            FROM shopping_cart sc
                     JOIN book b ON sc.book_id = b.book_id
            WHERE sc.consumer_id = ?
        `, [consumer_id]);

        if (cartItems.length === 0) throw new Error('购物车为空');

        // 计算金额
        let subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        let discountedPrice = subtotal * discountRate;
        let totalPrice = discountedPrice + 10; // 加运费

        // 🚨 修正3：写入 sale 表，严格匹配新表字段名 payment_status, delivery_status 等
        const [saleResult] = await connection.query(`
            INSERT INTO sale (consumer_id, total_price, paid_amount, payment_status, delivery_status, order_time)
            VALUES (?, ?, ?, '已支付', '未发货', NOW())
        `, [consumer_id, totalPrice, discountedPrice]);

        const saleId = saleResult.insertId;

        // 🚨 修正4：写入 detail 表，字段改为 quantity，并加上新表必填的 unit_price
        for (const item of cartItems) {
            await connection.query(`
                INSERT INTO detail (sale_id, book_id, quantity, unit_price)
                VALUES (?, ?, ?, ?)
            `, [saleId, item.book_id, item.quantity, item.price]);

            // 🌟 正常执行扣除库存
            await connection.query(
                'UPDATE book SET stock = stock - ? WHERE book_id = ?',
                [item.quantity, item.book_id]
            );
        }

        // 🚨 修正5：清空购物车，表名为 shopping_cart
        await connection.query('DELETE FROM shopping_cart WHERE consumer_id = ?', [consumer_id]);

        // ====== 🌟 新增小功能：积分赠送与 VIP 自动升级 ======
        const earnedPoints = Math.floor(discountedPrice); // 1元=1积分，向下取整

        // 利用 MySQL 的 CASE WHEN 实现无缝的阶梯升级逻辑
        await connection.query(`
            UPDATE consumer 
            SET integral = integral + ?,
                vip_level = CASE
                    WHEN integral + ? >= 5000 THEN 3  -- 满5000分升钻石(3)
                    WHEN integral + ? >= 2000 THEN 2  -- 满2000分升金卡(2)
                    WHEN integral + ? >= 500 THEN 1   -- 满500分升银卡(1)
                    ELSE vip_level 
                END
            WHERE consumer_id = ?
        `, [earnedPoints, earnedPoints, earnedPoints, earnedPoints, consumer_id]);

        await connection.commit();
        res.json({ success: true, message: `结算成功！会员等级：${level}，已享${discountRate * 10}折` });

    } catch (error) {
        await connection.rollback();
        console.error('下单过程崩溃:', error); // 打印红字日志，方便以后排错
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// 🌟 新增小功能：猜你喜欢 (同类书籍推荐)
app.get('/api/books/:id/related', async (req, res) => {
    try {
        const bookId = req.params.id;

        // 核心逻辑：先查出这本书的分类，然后再查同分类下的其他书，按 RAND() 随机打乱取 4 本
        const sql = `
            SELECT book_id, book_name, author, price, cover_img 
            FROM book 
            WHERE category_id = (SELECT category_id FROM book WHERE book_id = ?) 
              AND book_id != ? 
              AND stock > 0
            ORDER BY RAND() 
            LIMIT 4
        `;
        const [rows] = await pool.query(sql, [bookId, bookId]);

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('推荐书籍获取失败:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 🌟 新增小功能：我的数字书架 (已购图书去重列表)
app.get('/api/users/:userId/bookshelf', async (req, res) => {
    try {
        // 核心逻辑：订单表关联明细表再关联图书表，只要支付成功就算买过，并用 DISTINCT 去重
        const sql = `
            SELECT DISTINCT
                b.book_id,
                b.book_name,
                b.author,
                b.isbn
            FROM sale s
            JOIN detail d ON s.sale_id = d.sale_id
            JOIN book b ON d.book_id = b.book_id
            WHERE s.consumer_id = ? AND s.payment_status = '已支付'
            ORDER BY b.book_id DESC
        `;
        const [rows] = await pool.query(sql, [req.params.userId]);

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取书架失败:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 11. 登录接口 (POST)
app.post('/api/login', async (req, res) => {
    const { username, password, role } = req.body;
    try {
        // 🚨 修正：新表管理员叫 admin，字段名统一为带下划线格式
        let table = role === 'admin' ? 'admin' : 'consumer';
        let nameField = role === 'admin' ? 'admin_name' : 'consumer_name';
        let passField = role === 'admin' ? 'admin_pass' : 'consumer_pass';

        const sql = `SELECT * FROM ${table} WHERE ${nameField} = ? AND ${passField} = ?`;
        const [rows] = await pool.query(sql, [username, password]);

        if (rows.length > 0) {
            const user = rows[0];
            const idField = role === 'admin' ? 'admin_id' : 'consumer_id';

            res.json({
                success: true,
                user: { id: user[idField], name: user[nameField], role: role }
            });
        } else {
            res.status(401).json({ success: false, message: '账号或密码错误' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '服务器报错' });
    }
});


// 📚 Admin: 上架新书 (POST) - 唯一正确版
app.post('/api/admin/books', async (req, res) => {
    // 接收前端发来的数据
    const { book_name, author, isbn, price, stock, category_id } = req.body;

    try {
        // 🚨 核心修复 1：你的新 book 表直接存 category_id 即可，不需要再翻译成文字了！
        // ⚠️ 保证不删你的代码，我把你原来这段翻译逻辑注释掉了，留作备份纪念：
        /*
        let catName = '综合';
        if (category_id) {
            const [cats] = await pool.query('SELECT category_name FROM categories WHERE category_id = ?', [category_id]);
            if (cats.length > 0) {
                catName = cats[0].category_name;
            } else {
                catName = category_id; // 兜底：万一前端传的就是文字，直接用
            }
        }
        */

        // 🚨 核心修复 2：严格对齐新 book 表的字段 (book_name, category_id 等)
        await pool.query(
            'INSERT INTO book (book_name, author, isbn, price, stock, quality, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                book_name,
                author || '佚名',               // 兜底：前端没传作者，就填'佚名'
                isbn || `SYS-${Date.now()}`,    // 兜底：前端没传ISBN，自动生成
                price || 0,
                stock || 0,
                '全新',                         // 兜底：默认新书
                category_id || 1                // 👈 直接存入数字 ID
            ]
        );
        res.json({ success: true, message: '新书上架成功！' });
    } catch (error) {
        console.error('上架新书崩溃:', error.message);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 📚 Admin: 终极删除/下架图书 (唯一正确版，全场只能有这一个)
app.delete('/api/admin/books/:id', async (req, res) => {
    const bookId = req.params.id;
    try {
        // 🚨 修正表名和字段：shopcar -> shopping_cart，bookid -> book_id
        await pool.query('DELETE FROM shopping_cart WHERE book_id = ?', [bookId]);
        await pool.query('DELETE FROM book WHERE book_id = ?', [bookId]);
        res.json({ success: true, message: '书籍彻底物理删除成功！' });
    } catch (error) {
        // 🌟 核心修复 3：把库存设为 -1，当作“已下架/已删除”的标记 (bookid 改为 book_id)
        try {
            await pool.query('UPDATE book SET stock = -1 WHERE book_id = ?', [bookId]);
            res.json({ success: true, message: '该书有交易记录，已转为软下架隐藏！' });
        } catch (err2) {
            res.status(500).json({ success: false, message: '服务器彻底罢工了' });
        }
    }
});

// ====== 在 server.js 里面追加这段 ======

// 14. Admin: 修改图书信息 (PUT)
app.put('/api/admin/books/:id', async (req, res) => {
    // 接收前端表单传来的数据（前端传的是什么名字，这里就原样接收）
    const { book_name, author, price, stock } = req.body;

    try {
        // 🚨 核心修复：SQL 语句里的列名必须完全等于 Navicat 里的新名字 (book_name, book_id)
        // 并且去掉了不存在的 category_id
        await pool.query(
            'UPDATE book SET book_name = ?, author = ?, price = ?, stock = ? WHERE book_id = ?',
            [book_name, author || '', price, stock, req.params.id]
        );
        res.json({ success: true, message: '图书修改成功！' });
    } catch (error) {
        console.error('修改图书信息崩溃:', error.message);
        res.status(500).json({ success: false, message: '修改失败' });
    }
});


// ====== 在 server.js 里面追加这段 ======

// 15. 新用户注册接口 (POST) - 完备版
app.post('/api/register', async (req, res) => {
    const { username, password, email } = req.body; // 🚨 剔除前端传来的 phone
    try {
        // 🚨 修正查询字段：consumername -> consumer_name
        const [exist] = await pool.query('SELECT * FROM consumer WHERE consumer_name = ?', [username]);
        if (exist.length > 0) {
            return res.status(400).json({ success: false, message: '该用户名已被注册，请换一个' });
        }

        // 🚨 严格对齐字段名：consumer_name, consumer_pass, vip_level
        // ⚠️ 新表删除了 balance，所以我在这里把它从 INSERT 语句里拿掉了
        const [result] = await pool.query(
            'INSERT INTO consumer (consumer_name, consumer_pass, email, vip_level, integral, register_time) VALUES (?, ?, ?, 0, 0, NOW())',
            [username, password, email]
        );

        res.json({
            success: true,
            message: '注册成功！',
            user: { id: result.insertId, name: username, role: 'user' }
        });
    } catch (error) {
        console.error('注册失败:', error.message);
        res.status(500).json({ success: false, message: '服务器开小差了，注册失败' });
    }
});

// 18. 获取所有分类字典
app.get('/api/categories', async (req, res) => {
    try {
        // 🌟 核心修复：根据你的 Navicat 截图，新表名是 category（不带s了）
        // 并且字段名严格匹配 category_id 和 category_name
        const [rows] = await pool.query('SELECT category_id, category_name FROM category');

        res.json({ success: true, data: rows });
    } catch (error) {
        // 如果这里还报错，Render 的后台日志会打印出下面这行红字，告诉你具体错在哪
        console.error('获取分类失败:', error.message);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// ==========================================
// 🧑‍🤝‍🧑 客户关系管理 (Consumer Relations) 接口
// ==========================================

// 2. 获取某个客户的收货地址簿
app.get('/api/admin/consumers/:id/addresses', async (req, res) => {
    try {
        // 根据 consumer_id 去 address 表里查地址 (字段已是对的)
        const [rows] = await pool.query('SELECT * FROM address WHERE consumer_id = ? ORDER BY is_default DESC', [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取地址失败:', error);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 3. 修改客户信息
app.put('/api/admin/consumers/:id', async (req, res) => {
    // 去掉 phone，且因为新表移除了 balance 字段，这里我们接收它但不存入数据库
    const { consumer_name, email, vip_level, integral, balance } = req.body;
    try {
        // 🚨 严格对齐新表字段：consumer_name, vip_level, consumer_id
        // ⚠️ 移除了旧表的 balance
        const sql = `
            UPDATE consumer
            SET consumer_name = ?, email = ?, vip_level = ?, integral = ?
            WHERE consumer_id = ?
        `;
        await pool.query(sql, [consumer_name, email, vip_level, integral, req.params.id]);
        res.json({ success: true, message: '客户资料已更新' });
    } catch (error) {
        console.error('修改客户资料失败:', error.message);
        res.status(500).json({ success: false, message: '服务器异常，修改失败' });
    }
});

// 3.5 删除客户 (增加“无订单记录”安全检查)
app.delete('/api/admin/consumers/:id', async (req, res) => {
    const userId = req.params.id;
    try {
        // 🚨 严格对齐新表字段：sale_id, consumer_id
        const [orders] = await pool.query('SELECT sale_id FROM sale WHERE consumer_id = ?', [userId]);
        if (orders.length > 0) {
            return res.status(400).json({ success: false, message: '该客户存在历史订单记录，无法注销' });
        }
        await pool.query('DELETE FROM consumer WHERE consumer_id = ?', [userId]);
        res.json({ success: true, message: '客户账号已成功注销' });
    } catch (error) {
        console.error('注销客户失败:', error.message);
        res.status(500).json({ success: false, message: '服务器忙，请稍后再试' });
    }
});

// ==========================================
// 📦 订单履约中心 (Order Command Center) 接口
// ==========================================

// 1. 获取订单列表 (修复 Invalid Date 和状态丢失)
app.get('/api/admin/orders', async (req, res) => {
    try {
        // 🚨 修正：全面对齐 sale 表和 consumer 表的新字段名，但依然通过 AS 映射给前端
        const sql = `
            SELECT
                s.sale_id AS sale_id,
                s.total_price AS total_price,
                s.payment_status AS payment_status,
                s.delivery_status AS delivery_status,
                s.order_time AS order_time,
                c.consumer_name AS consumer_name
            FROM sale s
                     JOIN consumer c ON s.consumer_id = c.consumer_id
            ORDER BY s.sale_id DESC
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows || [] });
    } catch (error) {
        console.error('获取订单列表崩溃:', error.message);
        res.status(500).json({ success: false, message: '无法获取订单列表' });
    }
});

// 2. 获取订单明细 (修复无限 Loading)
app.get('/api/admin/orders/:id/details', async (req, res) => {
    try {
        // 🚨 修正：新表 detail 终于有了正规的 quantity (数量) 和 unit_price (单价) 字段了！
        // 告别原来用 quality 代替数量的奇葩历史
        const sql = `
            SELECT
                d.detail_id AS detail_id,
                d.book_id AS book_id,
                d.quantity AS quantity,   -- 🌟 正规化后的数量字段
                d.unit_price AS unit_price, -- 🌟 正规化后的单价字段
                b.book_name AS book_name,
                b.author
            FROM detail d
                     JOIN book b ON d.book_id = b.book_id
            WHERE d.sale_id = ?
        `;
        const [rows] = await pool.query(sql, [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取订单明细崩溃:', error.message);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 3. 级联删除订单，并自动退回库存
app.delete('/api/admin/orders/:id', async (req, res) => {
    const saleId = req.params.id;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 🌟 修正：从 detail 取出真正的 quantity (而不是 quality)，并对齐 book_id, sale_id
        const [items] = await connection.query('SELECT book_id, quantity FROM detail WHERE sale_id = ?', [saleId]);
        for (let item of items) {
            // 将 quantity 加回 stock 里
            await connection.query('UPDATE book SET stock = stock + ? WHERE book_id = ?', [item.quantity, item.book_id]);
        }

        // 退完库存后，正常删除明细和主订单 (修正 sale_id)
        await connection.query('DELETE FROM detail WHERE sale_id = ?', [saleId]);
        await connection.query('DELETE FROM sale WHERE sale_id = ?', [saleId]);

        await connection.commit();
        res.json({ success: true, message: '订单已删除，库存已成功退回仓库！' });
    } catch (error) {
        await connection.rollback();
        console.error('删除订单崩溃:', error.message);
        res.status(500).json({ success: false, message: '删除失败' });
    } finally {
        connection.release();
    }
});

// 4. 订单发货 (前端调用的是 /dispatch 路径)
app.put('/api/admin/orders/:id/dispatch', async (req, res) => {
    try {
        // 🚨 修正：statu -> delivery_status，saleid -> sale_id
        await pool.query("UPDATE sale SET delivery_status = '已发货' WHERE sale_id = ?", [req.params.id]);
        res.json({ success: true, message: '发货成功！' });
    } catch (error) {
        console.error('发货失败:', error.message);
        res.status(500).json({ success: false, message: '操作失败' });
    }
});

// 修改订单基础信息 (适配 Navicat 真实字段)
app.put('/api/admin/orders/:id', async (req, res) => {
    // 忽略数据库没有的地址和支付方式，只更新时间和状态
    const { order_time, delivery_status, payment_status } = req.body;
    try {
        // 🚨 修正：statu -> delivery_status, ifpay -> payment_status, saleid -> sale_id
        const sql = `
            UPDATE sale
            SET order_time = ?, delivery_status = ?, payment_status = ?
            WHERE sale_id = ?
        `;
        await pool.query(sql, [order_time, delivery_status, payment_status, req.params.id]);
        res.json({ success: true, message: '订单基础信息已更新' });
    } catch (error) {
        console.error('修改订单基础信息失败:', error.message);
        res.status(500).json({ success: false, message: '基础信息修改失败' });
    }
});

// 5. 修改订单明细数量并自动重算总价 (修复计算逻辑与字段)
app.put('/api/admin/orders/:saleId/details/:detailId', async (req, res) => {
    const { saleId, detailId } = req.params;
    const { quantity } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 🚨 修正：彻底告别 quality！新表使用正常的 quantity 字段，主键为 detail_id
        await connection.query('UPDATE detail SET quantity = ? WHERE detail_id = ?', [quantity, detailId]);

        // 重新计算该订单的总价: SUM(数量 * 书本单价)
        // 🚨 修正：联表查询的关联字段全部替换为 book_id, sale_id
        const [allDetails] = await connection.query(`
            SELECT SUM(d.quantity * b.price) as subtotal
            FROM detail d
                     JOIN book b ON d.book_id = b.book_id
            WHERE d.sale_id = ?
        `, [saleId]);

        const newTotal = (allDetails[0].subtotal || 0) + 10; // 加上 10 元运费

        // 🚨 修正：totalprice -> total_price, saleid -> sale_id
        await connection.query('UPDATE sale SET total_price = ? WHERE sale_id = ?', [newTotal, saleId]);

        await connection.commit();
        res.json({ success: true, newTotal });
    } catch (error) {
        await connection.rollback();
        console.error('修改数量崩溃:', error.message);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});



// ==========================================
// 👤 C端用户：个人中心接口 (User Profile)
// ==========================================
// 1. 获取用户的个人档案
app.get('/api/users/:id/profile', async (req, res) => {
    try {
        // 🚨 修正：新表已经全部是标准下划线字段，直接查即可。移除已被淘汰的 balance 字段。
        const [rows] = await pool.query(`
            SELECT consumer_id, consumer_name, email, vip_level, integral
            FROM consumer WHERE consumer_id = ?
        `, [req.params.id]);

        if (rows.length > 0) {
            res.json({ success: true, data: rows[0] });
        } else {
            res.json({ success: false, message: '用户不存在' });
        }
    } catch (error) {
        console.error('获取个人信息失败:', error.message);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 2. 用户修改自己的个人信息 (剔除数据库没有的 phone 字段)
app.put('/api/users/:id/profile', async (req, res) => {
    const { consumer_name, email } = req.body; // 不要接收 phone，因为数据库没这个列
    try {
        // 🚨 修正：consumername -> consumer_name, consumerid -> consumer_id
        await pool.query(
            'UPDATE consumer SET consumer_name = ?, email = ? WHERE consumer_id = ?',
            [consumer_name, email, req.params.id]
        );
        res.json({ success: true, message: '个人资料更新成功' });
    } catch (error) {
        console.error('更新个人信息失败:', error.message);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// ==========================================
// 🏠 C端用户：地址管理接口
// ==========================================

// 1. C端用户查询自己的地址簿
app.get('/api/users/:id/addresses', async (req, res) => {
    try {
        // 查自己的地址，并把默认地址 (is_default = 1) 排在最前面
        // 🌟 你的新 address 表本身就非常规范，这句 SQL 完美匹配！
        const [rows] = await pool.query('SELECT * FROM address WHERE consumer_id = ? ORDER BY is_default DESC, address_id DESC', [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取我的地址失败:', error);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 2. C端用户设置默认地址
app.put('/api/users/:id/addresses/:addressId/default', async (req, res) => {
    const userId = req.params.id;
    const targetAddressId = req.params.addressId;
    const connection = await pool.getConnection(); // 需要用事务保证一致性

    try {
        await connection.beginTransaction();
        // 第一步：把该用户的所有地址 is_default 都设为 0 (取消他现有的默认地址)
        await connection.query('UPDATE address SET is_default = 0 WHERE consumer_id = ?', [userId]);
        // 第二步：把他点击的那个地址 is_default 设为 1
        await connection.query('UPDATE address SET is_default = 1 WHERE consumer_id = ? AND address_id = ?', [userId, targetAddressId]);

        await connection.commit();
        res.json({ success: true, message: '默认地址设置成功' });
    } catch (error) {
        await connection.rollback();
        console.error('设置默认地址失败:', error);
        res.status(500).json({ success: false, message: '服务器异常' });
    } finally {
        connection.release();
    }
});

// ==========================================
// 📊 管理员数据大盘接口 (Executive Dashboard) - 终极稳健版
// ==========================================

app.get('/api/admin/dashboard/stats', async (req, res) => {
    try {
        // 🚨 修正：totalprice -> total_price, ifpay -> payment_status
        const [todayRev] = await pool.query(`SELECT SUM(total_price) AS rev FROM sale WHERE DATE(order_time) = CURDATE() AND payment_status = '已支付'`);
        // 🚨 修正：d.quality -> d.quantity, saleid -> sale_id
        const [todayQty] = await pool.query(`SELECT SUM(d.quantity) AS qty FROM sale s JOIN detail d ON s.sale_id = d.sale_id WHERE DATE(s.order_time) = CURDATE() AND s.payment_status = '已支付'`);

        const [monthRev] = await pool.query(`SELECT SUM(total_price) AS rev FROM sale WHERE YEAR(order_time) = YEAR(CURDATE()) AND MONTH(order_time) = MONTH(CURDATE()) AND payment_status = '已支付'`);
        const [monthQty] = await pool.query(`SELECT SUM(d.quantity) AS qty FROM sale s JOIN detail d ON s.sale_id = d.sale_id WHERE YEAR(s.order_time) = YEAR(CURDATE()) AND MONTH(s.order_time) = MONTH(CURDATE()) AND s.payment_status = '已支付'`);

        const [users] = await pool.query('SELECT COUNT(*) AS total FROM consumer');
        const [books] = await pool.query('SELECT COUNT(*) AS total FROM book');

        res.json({
            success: true,
            data: {
                todayBooks: todayQty[0]?.qty || 0,
                todayRevenue: todayRev[0]?.rev || 0,
                monthBooks: monthQty[0]?.qty || 0,
                monthRevenue: monthRev[0]?.rev || 0,
                totalUsers: users[0]?.total || 0,
                totalBooks: books[0]?.total || 0
            }
        });
    } catch (error) {
        console.error('🔥 大盘数据统计异常:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 19. 获取库存预警列表 (映射正确的 book_id 和 book_name)
app.get('/api/admin/inventory/warning', async (req, res) => {
    try {
        // 🚨 修正：bookid -> book_id, bookname -> book_name
        const [rows] = await pool.query('SELECT book_id, book_name, stock FROM book WHERE stock < 5 ORDER BY stock ASC');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取库存预警失败:', error.message);
        res.status(500).json({ success: false, message: '获取预警失败' });
    }
});

app.get('/api/admin/analysis/category', async (req, res) => {
    try {
        // 🚨 修正：book 表不再有 categoryname，改用连表 category 查询 category_name
        // 并把 d.quality 修正为真正的 d.quantity
        const sql = `
            SELECT
                c.category_name as category,
                SUM(d.quantity) as total_qty,
                SUM(d.quantity * b.price) as total_amount
            FROM detail d
                     JOIN book b ON d.book_id = b.book_id
                     LEFT JOIN category c ON b.category_id = c.category_id
            GROUP BY c.category_name
            ORDER BY total_amount DESC
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('品类分析报错:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/analysis/vip', async (req, res) => {
    try {
        // 🚨 修正：vip -> vip_level, consumerid -> consumer_id, totalprice -> total_price
        // ⚠️ 新表删除了 balance 字段，这里我们改成统计平均积分 (integral)，前端变量名暂不改变以防报错
        const sql = `
            SELECT
                c.vip_level as vip_level,
                COUNT(DISTINCT c.consumer_id) as user_count,
                SUM(s.total_price) as total_revenue,
                AVG(c.integral) as avg_balance
            FROM consumer c
                     LEFT JOIN sale s ON c.consumer_id = s.consumer_id
            GROUP BY c.vip_level
            ORDER BY user_count DESC
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('会员分析报错:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 获取我的订单 (前端 C端 MyOrders.vue 和大盘共用)
app.get('/api/orders/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;

        // 🚨 修正1：严格匹配 sale 表的新字段名，AS 后面保留前端需要的变量名
        const [orders] = await pool.query(`
            SELECT
                sale_id AS sale_id,
                total_price AS total_price,
                payment_status AS payment_status,
                delivery_status AS delivery_status,
                order_time AS created_at
            FROM sale
            WHERE consumer_id = ?
            ORDER BY sale_id DESC
        `, [userId]);

        // 🚨 修正2：循环查询订单明细，对齐新表 detail 的 quantity 和 book 的 book_id / book_name
        for (let order of orders) {
            const [details] = await pool.query(`
                SELECT
                    d.quantity AS quantity,
                    b.price AS unit_price,
                    b.book_name AS book_name,
                    b.book_id AS book_id
                FROM detail d
                         JOIN book b ON d.book_id = b.book_id
                WHERE d.sale_id = ?
            `, [order.sale_id]);

            order.items = details; // 把查出来的明细塞进订单里返回给前端
        }

        res.json({ success: true, data: orders });
    } catch (error) {
        console.error('获取历史订单崩溃:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 1. 获取所有客户列表 (Admin端专用)
app.get('/api/admin/consumers', async (req, res) => {
    try {
        // 🌟 核心修正：对齐新的 consumer 表字段，剔除不存在的 balance 字段
        const sql = `
            SELECT
                consumer_id AS consumer_id,
                consumer_name AS consumer_name,
                email,
                vip_level AS vip_level,
                integral,
                register_time
            FROM consumer
            ORDER BY register_time DESC
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取客户列表失败:', error.message);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 1. 获取所有客户列表 (Admin端专用)
app.get('/api/admin/consumers', async (req, res) => {
    try {
        // 🌟 核心修正：对齐新的 consumer 表字段，剔除不存在的 balance 字段
        const sql = `
            SELECT
                consumer_id AS consumer_id,
                consumer_name AS consumer_name,
                email,
                vip_level AS vip_level,
                integral,
                register_time
            FROM consumer
            ORDER BY register_time DESC
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取客户列表失败:', error.message);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});
// 1. 获取核心客户贡献榜 (修复 404 丢失问题)
app.get('/api/admin/analysis/top-customers', async (req, res) => {
    try {
        // 🚨 修正：严格对齐新表的 consumer_name, total_price, consumer_id
        const sql = `
            SELECT
                c.consumer_name AS consumer_name,
                SUM(s.total_price) AS total_spent
            FROM sale s
                     JOIN consumer c ON s.consumer_id = c.consumer_id
            GROUP BY c.consumer_id, c.consumer_name
            ORDER BY total_spent DESC
                LIMIT 5
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('客户排行榜报错:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 2. 获取畅销书榜单 (修复字段名映射)
app.get('/api/admin/analysis/top-books', async (req, res) => {
    try {
        // 🚨 修正：bookname -> book_name, bookid -> book_id
        // 🌟 彻底消灭 quality！使用正确的 quantity 字段统计销量
        const sql = `
            SELECT
                b.book_name AS book_name,
                SUM(d.quantity) AS total_sold
            FROM detail d
                     JOIN book b ON d.book_id = b.book_id
            GROUP BY b.book_id, b.book_name
            ORDER BY total_sold DESC
                LIMIT 5
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('畅销书排行榜报错:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 3. 获取物流状态分布
app.get('/api/admin/analysis/logistics', async (req, res) => {
    try {
        // 🚨 修正：statu 变更为 delivery_status
        const sql = `
            SELECT
                delivery_status AS delivery_status,
                COUNT(*) AS count
            FROM sale
            GROUP BY delivery_status
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('物流状态分析报错:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Backend server is running on port ${PORT}`);
});