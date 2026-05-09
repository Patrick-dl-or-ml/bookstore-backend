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
        const [rows] = await pool.query(`
            SELECT
                sc.carid AS cart_id,
                1 AS quantity,              -- 🌟 强行给个默认数量1，防止你没在表里建 quantity 字段导致崩溃
                b.bookid AS book_id,
                b.bookname AS book_name,
                b.author,
                b.price,
                b.quality
            FROM shopcar sc                 -- 🌟 修正为你真实的表名 shopcar
                     JOIN book b ON sc.bookid = b.bookid
            WHERE sc.consumerid = ?         -- 🌟 修正为你真实的字段 consumerid
            ORDER BY sc.carid DESC          -- 🌟 用 carid 倒序，因为你表里没有 add_time
        `, [consumerId]);

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取购物车失败:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 4. 获取图书列表 (适配你的数据库字段：quality, categoryname)
app.get('/api/books', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12; // 商店一页多显示点
    const offset = (page - 1) * limit;

    const keyword = req.query.keyword;
    const category = req.query.category;

    try {
        // 注意：这里去掉了 LEFT JOIN，直接查 book 表里的 categoryname
        let baseSql = ` FROM book WHERE 1=1 `;
        let params = [];

        if (keyword) {
            baseSql += ` AND (bookname LIKE ? OR author LIKE ?)`;
            params.push(`%${keyword}%`, `%${keyword}%`);
        }

        if (category && category !== 'All') {
            baseSql += ` AND categoryname = ?`;
            params.push(category);
        }

        const [countResult] = await pool.query(`SELECT COUNT(*) as total ${baseSql}`, params);
        const total = countResult[0].total;

        // 🌟 核心修复：用 AS 把数据库的列名映射成前端需要的变量名，并伪造一个 stock 库存
        const dataSql = `
    SELECT 
        bookid AS book_id, 
        bookname AS book_name, 
        author, 
        isbn, 
        categoryname AS category_name, 
        quality, 
        price, 
        50 AS stock 
    ${baseSql} ORDER BY bookid DESC LIMIT ? OFFSET ?
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
        // 🚨 修正1：表名改为 shopcar，字段名改为 consumerid, bookid, carid
        const [exist] = await pool.query(
            'SELECT carid FROM shopcar WHERE consumerid = ? AND bookid = ?',
            [consumer_id, book_id]
        );

        if (exist.length > 0) {
            // 如果已经有了，数量直接 +1 (⚠️ 前提是你在 Navicat 的 shopcar 表里加上了 quantity 字段)
            await pool.query(
                'UPDATE shopcar SET quantity = quantity + 1 WHERE carid = ?',
                [exist[0].carid]
            );
        } else {
            // 🚨 修正2：往 shopcar 表里插入数据，严格匹配数据库列名
            await pool.query(
                'INSERT INTO shopcar (consumerid, bookid, quantity) VALUES (?, ?, 1)',
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

        // 🚨 修正1：查用户信息，字段为 consumerid 和 vip
        const [user] = await connection.query(
            'SELECT vip FROM consumer WHERE consumerid = ?',
            [consumer_id]
        );
        const level = user[0]?.vip || 0;

        // 折扣逻辑不变
        let discountRate = 1.0;
        if (level === 1) discountRate = 0.95; // 银卡 95折
        else if (level === 2) discountRate = 0.90; // 金卡 90折
        else if (level === 3) discountRate = 0.85; // 钻石 85折

        // 🚨 修正2：查购物车，表名为 shopcar，字段为 consumerid, bookid
        const [cartItems] = await connection.query(`
            SELECT sc.bookid AS book_id, sc.quantity, b.price
            FROM shopcar sc
                     JOIN book b ON sc.bookid = b.bookid
            WHERE sc.consumerid = ?
        `, [consumer_id]);

        if (cartItems.length === 0) throw new Error('购物车为空');

        // 计算金额
        let subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        let discountedPrice = subtotal * discountRate;
        let totalPrice = discountedPrice + 10; // 加运费

        // 🚨 修正3：写入 sale 表，严格匹配 Navicat 的字段名，并自动写入当前时间 NOW()
        const [saleResult] = await connection.query(`
            INSERT INTO sale (consumerid, totalprice, payprice, ifpay, statu, order_time)
            VALUES (?, ?, ?, '已支付', '未发货', NOW()) 
        `, [consumer_id, totalPrice, discountedPrice]);

        const saleId = saleResult.insertId;

        // 🚨 修正4：写入 detail 表，注意你的数量字段叫 quality
        for (const item of cartItems) {
            await connection.query(`
                INSERT INTO detail (saleid, bookid, quality)
                VALUES (?, ?, ?)
            `, [saleId, item.book_id, item.quantity]);

            // ⚠️ 如果你在 book 表里加了 stock 字段，请解除下面这三行的注释来扣除库存：
            // await connection.query(
            //     'UPDATE book SET stock = stock - ? WHERE bookid = ?',
            //     [item.quantity, item.book_id]
            // );
        }

        // 🚨 修正5：清空购物车，表名为 shopcar
        await connection.query('DELETE FROM shopcar WHERE consumerid = ?', [consumer_id]);

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

// ====== 在 server.js 里面追加这段 ======

// 7. 获取个人基本信息 (查询 consumer 表)
app.get('/api/user/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM consumer WHERE consumer_id = ?', [req.params.id]);
        if (rows.length > 0) {
            res.json({ success: true, data: rows[0] });
        } else {
            res.status(404).json({ success: false, message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 8. 获取该用户的历史订单 (查询 sale 表)
app.get('/api/user/:id/orders', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM sale WHERE consumer_id = ? ORDER BY order_time DESC',
            [req.params.id]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ====== 在 server.js 里面追加这段 ======

// 9. 管理员：上架新书 (POST)
app.post('/api/admin/books', async (req, res) => {
    const { book_name, author, isbn, price, stock, quality, category_id } = req.body;
    try {
        await pool.query(
            'INSERT INTO book (book_name, author, isbn, price, stock, quality, category_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, "上架")',
            [book_name, author, isbn, price, stock, quality, category_id]
        );
        res.json({ success: true, message: 'Book added successfully!' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Failed to add book' });
    }
});

// 10. 管理员：下架/删除图书 (DELETE)
app.delete('/api/admin/books/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM book WHERE book_id = ?', [req.params.id]);
        res.json({ success: true, message: 'Book deleted!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete book' });
    }
});

// 11. 登录接口 (POST)
app.post('/api/login', async (req, res) => {
    const { username, password, role } = req.body;
    try {
        // 修正：管理员表名叫 adm
        let table = role === 'admin' ? 'adm' : 'consumer';
        let nameField = role === 'admin' ? 'admname' : 'consumername';
        let passField = role === 'admin' ? 'admpass' : 'consumerpass';

        const sql = `SELECT * FROM ${table} WHERE ${nameField} = ? AND ${passField} = ?`;
        const [rows] = await pool.query(sql, [username, password]);

        if (rows.length > 0) {
            const user = rows[0];
            const idField = role === 'admin' ? 'admid' : 'consumerid';
            const nameValue = role === 'admin' ? 'admname' : 'consumername';

            res.json({
                success: true,
                user: { id: user[idField], name: user[nameValue], role: role }
            });
        } else {
            res.status(401).json({ success: false, message: '账号或密码错误' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '服务器报错' });
    }
});

// ====== 在 server.js 里面追加这段 ======

// 12. 管理员：上架新书 (POST)
app.post('/api/admin/books', async (req, res) => {
    const { book_name, author, isbn, price, stock, quality, category_id } = req.body;
    try {
        // 这里的 category_id 默认为 1（一般是“未分类”或“通用”）
        await pool.query(
            'INSERT INTO book (book_name, author, isbn, price, stock, quality, category_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, "上架")',
            [book_name, author, isbn, price, stock, quality, category_id || 1]
        );
        res.json({ success: true, message: '书籍上架成功！' });
    } catch (error) {
        console.error('上架失败:', error);
        res.status(500).json({ success: false, message: '上架失败，请检查字段' });
    }
});

// 13. 管理员：删除图书 (DELETE) - 双保险终极版
app.delete('/api/admin/books/:id', async (req, res) => {
    const bookId = req.params.id;
    try {
        // 第一步：先去购物车里把关联这本书的记录清空（解除外键约束 1）
        await pool.query('DELETE FROM shopping_cart WHERE book_id = ?', [bookId]);

        // 第二步：尝试直接从数据库里彻底物理删除
        await pool.query('DELETE FROM book WHERE book_id = ?', [bookId]);

        res.json({ success: true, message: '书籍已从数据库彻底删除！' });
    } catch (error) {
        console.error('物理删除失败，尝试触发降级下架方案:', error);

        // 如果物理删除失败（说明这本书在真实的 sale 订单表里存在，数据库拒绝删除以保全财务记录）
        // 第三步（降级方案）：把库存设为 -1，当做“软下架”处理
        try {
            await pool.query('UPDATE book SET stock = -1 WHERE book_id = ?', [bookId]);
            res.json({ success: true, message: '该书存在历史订单无法物理销毁，已强制清空库存并下架隐藏！' });
        } catch (err2) {
            res.status(500).json({ success: false, message: '服务器彻底罢工了，请看终端红字报错' });
        }
    }
});

// ====== 在 server.js 里面追加这段 ======

// 14. 管理员：修改图书信息 (PUT)
app.put('/api/admin/books/:id', async (req, res) => {
    // 🌟 修复点 1：在这里接收前端传来的 category_id
    const { price, stock, book_name, author, category_id } = req.body;

    try {
        await pool.query(
            // 🌟 修复点 2：把 category_id = ? 加进 SQL 语句中
            'UPDATE book SET book_name = ?, author = ?, price = ?, stock = ?, category_id = ? WHERE book_id = ?',
            [book_name, author, price, stock, category_id, req.params.id]
        );
        res.json({ success: true, message: '图书修改成功！' });
    } catch (error) {
        console.error('修改失败:', error);
        res.status(500).json({ success: false, message: '修改失败' });
    }
});


// ====== 在 server.js 里面追加这段 ======

// 15. 新用户注册接口 (POST) - 完备版 (对标需求文档 3.2.1)
app.post('/api/register', async (req, res) => {
    const { username, password, email, phone } = req.body;
    try {
        const [exist] = await pool.query('SELECT * FROM consumer WHERE consumer_name = ?', [username]);
        if (exist.length > 0) {
            return res.status(400).json({ success: false, message: '该用户名已被注册，请换一个' });
        }

        // 🌟 核心改进：记录注册时间 NOW() 和初始余额 0
        const [result] = await pool.query(
            'INSERT INTO consumer (consumer_name, consumer_pass, email, phone, vip_level, integral, balance, register_time) VALUES (?, ?, ?, ?, 0, 0, 0, NOW())',
            [username, password, email, phone]
        );

        res.json({
            success: true,
            message: '注册成功！',
            user: { id: result.insertId, name: username, role: 'user' }
        });
    } catch (error) {
        console.error('注册失败:', error);
        res.status(500).json({ success: false, message: '服务器开小差了，注册失败' });
    }
});

// ====== 在 server.js 里面追加这两段 ======

// 16. 修改购物车数量 (PUT)
app.put('/api/cart/:cartId', async (req, res) => {
    const { quantity } = req.body;
    try {
        if (quantity <= 0) {
            await pool.query('DELETE FROM shopcar WHERE carid = ?', [req.params.cartId]);
        } else {
            await pool.query('UPDATE shopcar SET quantity = ? WHERE carid = ?', [quantity, req.params.cartId]);
        }
        res.json({ success: true, message: '数量已更新' });
    } catch (error) {
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 17. 管理员：订单发货 (PUT)
app.put('/api/admin/orders/:id/deliver', async (req, res) => {
    try {
        await pool.query("UPDATE sale SET delivery_status = '已发货' WHERE sale_id = ?", [req.params.id]);
        res.json({ success: true, message: '发货成功！' });
    } catch (error) {
        console.error('发货失败:', error);
        res.status(500).json({ success: false, message: '操作失败' });
    }
});

// 18. 获取所有分类字典
app.get('/api/categories', async (req, res) => {
    try {
        // 🌟 核心修复：根据你的 Navicat 截图，表名是 categories（带s）
        // 并且字段名必须严格匹配 category_id 和 category_name
        const [rows] = await pool.query('SELECT category_id, category_name FROM categories');

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

// 1. 获取所有客户列表
app.get('/api/admin/consumers', async (req, res) => {
    try {
        // 查出 consumer 表里的所有数据，按注册时间倒序
        const [rows] = await pool.query('SELECT * FROM consumer ORDER BY register_time DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取客户列表失败:', error);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 2. 获取某个客户的收货地址簿
app.get('/api/admin/consumers/:id/addresses', async (req, res) => {
    try {
        // 根据 consumer_id 去 address 表里查地址
        const [rows] = await pool.query('SELECT * FROM address WHERE consumer_id = ? ORDER BY is_default DESC', [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取地址失败:', error);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 3. 修改客户信息 (对标 3.2.1：支持修改电话、等级、余额等)
app.put('/api/admin/consumers/:id', async (req, res) => {
    // 🌟 增加接收 balance 字段
    const { consumer_name, email, phone, vip_level, integral, balance } = req.body;

    try {
        const sql = `
            UPDATE consumer 
            SET consumer_name = ?, email = ?, phone = ?, vip_level = ?, integral = ?, balance = ? 
            WHERE consumer_id = ?
        `;
        await pool.query(sql, [consumer_name, email, phone, vip_level, integral, balance, req.params.id]);
        res.json({ success: true, message: '客户资料已更新' });
    } catch (error) {
        console.error('修改客户资料失败:', error);
        res.status(500).json({ success: false, message: '服务器异常，修改失败' });
    }
});

// 3.5 删除客户 (增加“无订单记录”安全检查[cite: 1])
app.delete('/api/admin/consumers/:id', async (req, res) => {
    const userId = req.params.id;
    try {
        // 第一步：安全检查，有订单记录的客户不许删[cite: 1]
        const [orders] = await pool.query('SELECT sale_id FROM sale WHERE consumer_id = ?', [userId]);
        if (orders.length > 0) {
            return res.status(400).json({
                success: false,
                message: '该客户存在历史订单记录，为保护财务数据无法物理注销'
            });
        }
        // 第二步：没订单才允许删
        await pool.query('DELETE FROM consumer WHERE consumer_id = ?', [userId]);
        res.json({ success: true, message: '客户账号已成功注销' });
    } catch (error) {
        console.error('注销客户失败:', error);
        res.status(500).json({ success: false, message: '服务器忙，请稍后再试' });
    }
});

// ==========================================
// 📦 订单履约中心 (Order Command Center) 接口
// ==========================================

// --- 修复高额订单监控接口 ---
app.get('/api/admin/orders', async (req, res) => {
    try {
        const sql = `
            SELECT
                s.saleid as sale_id,      -- 🌟 对应你表里的 saleid
                s.totalprice as total_price, -- 🌟 对应你表里的 totalprice
                c.consumername as consumer_name -- 🌟 对应你表里的 consumername
            FROM sale s
                     JOIN consumer c ON s.consumerid = c.consumerid
            ORDER BY s.saleid DESC
        `;
        const [rows] = await pool.query(sql);

        // 即使没有数据，也要返回一个空数组，防止前端报错
        res.json({
            success: true,
            data: rows || []
        });
    } catch (error) {
        console.error('orders 接口崩溃:', error);
        res.status(500).json({
            success: false,
            message: '无法获取订单列表',
            details: error.message
        });
    }
});

// 2. 获取订单明细 (保留原有逻辑)
app.get('/api/admin/orders/:id/details', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT d.*, b.book_name, b.author
            FROM detail d
                     JOIN book b ON d.book_id = b.book_id
            WHERE d.sale_id = ?
        `, [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 3. 级联删除订单：删除订单及其关联的所有明细 (对标 3.2.2.1)
app.delete('/api/admin/orders/:id', async (req, res) => {
    const saleId = req.params.id;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query('DELETE FROM detail WHERE sale_id = ?', [saleId]);
        await connection.query('DELETE FROM sale WHERE sale_id = ?', [saleId]);
        await connection.commit();
        res.json({ success: true, message: '订单及其明细已彻底级联删除' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: '删除失败' });
    } finally {
        connection.release();
    }
});

// 4. 修改订单基础信息 (日期、地址、支付状态)
app.put('/api/admin/orders/:id', async (req, res) => {
    const { order_time, payment_method, delivery_address, delivery_status, payment_status } = req.body;
    try {
        const sql = `
            UPDATE sale 
            SET order_time = ?, payment_method = ?, delivery_address = ?, 
                delivery_status = ?, payment_status = ? 
            WHERE sale_id = ?
        `;
        await pool.query(sql, [order_time, payment_method, delivery_address, delivery_status, payment_status, req.params.id]);
        res.json({ success: true, message: '订单基础信息已更新' });
    } catch (error) {
        res.status(500).json({ success: false, message: '基础信息修改失败' });
    }
});

// 5. 核心逻辑：修改明细数量并自动重算订单总额 (对标 3.2.2.1)
app.put('/api/admin/orders/:saleId/details/:detailId', async (req, res) => {
    const { saleId, detailId } = req.params;
    const { quantity } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const [detail] = await connection.query('SELECT unit_price FROM detail WHERE detail_id = ?', [detailId]);
        if (detail.length === 0) throw new Error('明细不存在');

        await connection.query('UPDATE detail SET quantity = ? WHERE detail_id = ?', [quantity, detailId]);

        // 重新汇总金额 + 10元固定运费[cite: 1]
        const [allDetails] = await connection.query('SELECT SUM(quantity * unit_price) as subtotal FROM detail WHERE sale_id = ?', [saleId]);
        const newTotal = (allDetails[0].subtotal || 0) + 10;

        await connection.query('UPDATE sale SET total_price = ? WHERE sale_id = ?', [newTotal, saleId]);
        await connection.commit();
        res.json({ success: true, message: '明细已调整，订单总额已自动同步重算', newTotal });
    } catch (error) {
        await connection.rollback();
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
        const [rows] = await pool.query('SELECT * FROM consumer WHERE consumer_id = ?', [req.params.id]);
        if (rows.length > 0) {
            // 把密码剔除，保护隐私
            const { consumer_pass, ...safeData } = rows[0];
            res.json({ success: true, data: safeData });
        } else {
            res.json({ success: false, message: '用户不存在' });
        }
    } catch (error) {
        console.error('获取个人信息失败:', error);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 2. 用户修改自己的个人信息
app.put('/api/users/:id/profile', async (req, res) => {
    const { consumer_name, email, phone } = req.body;
    try {
        // C端用户只能改这三个字段，绝不能让他们自己改 vip_level 和 integral！
        await pool.query(
            'UPDATE consumer SET consumer_name = ?, email = ?, phone = ? WHERE consumer_id = ?',
            [consumer_name, email, phone, req.params.id]
        );
        res.json({ success: true, message: '个人资料更新成功' });
    } catch (error) {
        console.error('更新个人信息失败:', error);
        res.status(500).json({ success: false, message: '服务器异常' });
    }
});

// 3. 用户查询自己的专属订单
app.get('/api/users/:id/orders', async (req, res) => {
    try {
        // 只能查 consumer_id 是自己的订单
        const [rows] = await pool.query('SELECT * FROM sale WHERE consumer_id = ? ORDER BY order_time DESC', [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取我的订单失败:', error);
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
        // 今日营收：使用 totalprice 和 ifpay
        const [todayRev] = await pool.query(`SELECT SUM(totalprice) AS rev FROM sale WHERE DATE(order_time) = CURDATE() AND ifpay = '已支付'`);
        // 今日销量：注意这里把 quantity 改成了你表里的 quality
        const [todayQty] = await pool.query(`SELECT SUM(d.quality) AS qty FROM sale s JOIN detail d ON s.saleid = d.saleid WHERE DATE(s.order_time) = CURDATE() AND s.ifpay = '已支付'`);

        const [monthRev] = await pool.query(`SELECT SUM(totalprice) AS rev FROM sale WHERE YEAR(order_time) = YEAR(CURDATE()) AND MONTH(order_time) = MONTH(CURDATE()) AND ifpay = '已支付'`);
        const [monthQty] = await pool.query(`SELECT SUM(d.quality) AS qty FROM sale s JOIN detail d ON s.saleid = d.saleid WHERE YEAR(s.order_time) = YEAR(CURDATE()) AND MONTH(s.order_time) = MONTH(CURDATE()) AND s.ifpay = '已支付'`);

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

// 19. 获取库存预警列表 (对应文档 3.1.2 需求)[cite: 1]
app.get('/api/admin/inventory/warning', async (req, res) => {
    try {
        // 查找库存低于 10 本的图书[cite: 1]
        const [rows] = await pool.query('SELECT book_id, book_name, stock FROM book WHERE stock < 5 ORDER BY stock ASC');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取预警失败' });
    }
});

app.get('/api/admin/analysis/category', async (req, res) => {
    try {
        const sql = `
            SELECT
                b.categoryname as category,
                SUM(d.quality) as total_qty, -- 🌟 你的表里叫 quality
                SUM(d.quality * b.price) as total_amount -- 🌟 销量乘以单价
            FROM detail d
                     JOIN book b ON d.bookid = b.bookid -- 🌟 你的表里叫 bookid
            GROUP BY b.categoryname
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
        const sql = `
            SELECT
                c.vip as vip_level,
                COUNT(DISTINCT c.consumerid) as user_count,
                SUM(s.totalprice) as total_revenue,
                AVG(c.balance) as avg_balance
            FROM consumer c
                     LEFT JOIN sale s ON c.consumerid = s.consumerid
            GROUP BY c.vip
            ORDER BY user_count DESC
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('会员分析报错:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 获取我的订单 (前端 C端 MyOrders.vue 和大盘共用)
app.get('/api/orders/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;

        // 🚨 修正1：严格匹配 sale 表的真实字段（saleid, totalprice, ifpay, statu, consumerid, order_time）
        // 然后用 AS 翻译成前端需要的变量名
        const [orders] = await pool.query(`
            SELECT
                saleid AS sale_id,
                totalprice AS total_price,
                ifpay AS payment_status,
                statu AS delivery_status,
                order_time AS created_at
            FROM sale
            WHERE consumerid = ?
            ORDER BY saleid DESC
        `, [userId]);

        // 🚨 修正2：循环查询订单明细，严格匹配 detail 和 book 表的真实字段
        for (let order of orders) {
            const [details] = await pool.query(`
                SELECT
                    d.quality AS quantity,   -- 你的明细表里存数量的字段叫 quality
                    b.price AS unit_price,   -- 从 book 表里拿单价
                    b.bookname AS book_name,
                    b.bookid AS book_id
                FROM detail d
                         JOIN book b ON d.bookid = b.bookid
                WHERE d.saleid = ?
            `, [order.sale_id]);

            order.items = details; // 把查出来的明细塞进订单里返回给前端
        }

        res.json({ success: true, data: orders });
    } catch (error) {
        console.error('获取历史订单崩溃:', error.message); // 打印红字方便排错
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Backend server is running on port ${PORT}`);
});

// 1. 获取所有客户列表
app.get('/api/admin/consumers', async (req, res) => {
    try {
        // 🚨 核心修正：严格映射 consumerid, consumername, vip 等字段给前端
        const sql = `
            SELECT
                consumerid AS consumer_id,
                consumername AS consumer_name,
                email,
                vip AS vip_level,
                integral,
                balance,
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
app.get('/api/admin/analysis/top-books', async (req, res) => {
    try {
        const sql = `
            SELECT b.bookname as book_name, SUM(d.quality) as total_sold
            FROM detail d
                     JOIN book b ON d.bookid = b.bookid
            GROUP BY b.bookid
            ORDER BY total_sold DESC
                LIMIT 5
        `;
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('top-books 报错:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/analysis/logistics', async (req, res) => {
    try {
        const sql = `
            SELECT
                statu AS delivery_status, -- 🌟 把数据库里的 statu 映射为前端需要的 delivery_status
                COUNT(*) AS count
            FROM sale
            GROUP BY statu
        `;
        const [rows] = await pool.query(sql);
        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error('物流分析接口报错:', error);
        res.status(500).json({
            success: false,
            message: '无法获取物流数据',
            details: error.message
        });
    }
});