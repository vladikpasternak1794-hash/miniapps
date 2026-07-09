import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CORS - РАЗРЕШАЕМ ВСЕМ ==========
app.use(cors({
    origin: '*',  // РАЗРЕШАЕТ ЛЮБЫЕ САЙТЫ
    credentials: true
}));

app.use(express.json());

// ========== ПРОВЕРЯЕМ ПЕРЕМЕННЫЕ ==========
console.log('🔍 Проверка переменных:');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? '✅ Есть' : '❌ Нет');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Есть' : '❌ Нет');
console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? '✅ Есть' : '❌ Нет');

if (!process.env.BOT_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('❌ ОШИБКА: Не все переменные окружения заданы!');
    process.exit(1);
}

// ========== ПОДКЛЮЧАЕМ SUPABASE ==========
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// ========== ПРОВЕРКА TELEGRAM ==========
function verifyTelegramInitData(initData, botToken) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        
        const paramsArray = Array.from(params.entries());
        paramsArray.sort((a, b) => a[0].localeCompare(b[0]));
        const dataCheckString = paramsArray
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();
        
        const computedHash = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');
        
        if (computedHash !== hash) {
            console.log('❌ Hash mismatch');
            return null;
        }
        
        const authDate = parseInt(params.get('auth_date'));
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime - authDate > 86400) {
            console.log('❌ Data expired');
            return null;
        }
        
        return JSON.parse(params.get('user'));
    } catch (error) {
        console.error('❌ Verification error:', error);
        return null;
    }
}

// ========== МИДЛВЭР АУТЕНТИФИКАЦИИ ==========
async function authMiddleware(req, res, next) {
    try {
        const initData = req.headers['x-telegram-init-data'];
        
        if (!initData) {
            console.log('❌ Нет initData');
            return res.status(401).json({ error: 'Unauthorized: No initData' });
        }
        
        const user = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
        
        if (!user) {
            console.log('❌ Невалидный initData');
            return res.status(401).json({ error: 'Unauthorized: Invalid initData' });
        }
        
        console.log('✅ Пользователь авторизован:', user.id);
        
        // Сохраняем пользователя в БД
        const { data: existingUser } = await supabase
            .from('users')
            .select('telegram_id')
            .eq('telegram_id', user.id.toString())
            .single();
        
        if (!existingUser) {
            console.log('🆕 Создаем нового пользователя');
            await supabase
                .from('users')
                .insert({
                    telegram_id: user.id.toString(),
                    username: user.username || '',
                    first_name: user.first_name || '',
                    last_name: user.last_name || ''
                });
        }
        
        req.telegramUser = {
            id: user.id.toString(),
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name
        };
        
        next();
    } catch (error) {
        console.error('❌ Auth middleware error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// ========== API ЭНДПОЙНТЫ ==========

// Корневой маршрут - проверка, что сервер жив
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Server is running!',
        timestamp: new Date().toISOString()
    });
});

// Получить пользователя
app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', req.telegramUser.id)
            .single();
        
        if (error) {
            console.error('❌ Ошибка получения пользователя:', error);
            return res.status(500).json({ error: 'Failed to get user' });
        }
        
        res.json(data);
    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Получить события за месяц
app.get('/api/events/month/:year/:month', authMiddleware, async (req, res) => {
    try {
        const { year, month } = req.params;
        const startDate = `${year}-${month.padStart(2, '0')}-01`;
        const endDate = `${year}-${month.padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
        
        const { data, error } = await supabase
            .from('events')
            .select('*')
            .gte('event_date', startDate)
            .lte('event_date', endDate)
            .order('event_date', { ascending: true });
        
        if (error) {
            console.error('❌ Ошибка получения событий:', error);
            return res.status(500).json({ error: 'Failed to fetch events' });
        }
        
        res.json(data);
    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Создать событие
app.post('/api/events', authMiddleware, async (req, res) => {
    try {
        const { event_date, event_time, location, goal, description } = req.body;
        const user = req.telegramUser;
        
        const { data, error } = await supabase
            .from('events')
            .insert({
                created_by: user.id,
                event_date,
                event_time,
                location,
                goal,
                description
            })
            .select()
            .single();
        
        if (error) {
            console.error('❌ Ошибка создания события:', error);
            return res.status(500).json({ error: 'Failed to create event' });
        }
        
        res.status(201).json(data);
    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Участие в событии
app.post('/api/events/:id/participate', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const user = req.telegramUser;
        
        const { data, error } = await supabase
            .from('event_participants')
            .upsert({
                event_id: id,
                telegram_id: user.id,
                status
            })
            .select()
            .single();
        
        if (error) {
            console.error('❌ Ошибка участия:', error);
            return res.status(500).json({ error: 'Failed to update participation' });
        }
        
        res.json(data);
    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Голосование
app.post('/api/votes/:eventId', authMiddleware, async (req, res) => {
    try {
        const { eventId } = req.params;
        const { vote_type } = req.body;
        const user = req.telegramUser;
        
        const { data, error } = await supabase
            .from('votes')
            .upsert({
                event_id: eventId,
                telegram_id: user.id,
                vote_type
            })
            .select()
            .single();
        
        if (error) {
            console.error('❌ Ошибка голосования:', error);
            return res.status(500).json({ error: 'Failed to vote' });
        }
        
        res.json(data);
    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Сборы средств
app.post('/api/fundraisings', authMiddleware, async (req, res) => {
    try {
        const { event_id, title, description, target_amount } = req.body;
        const user = req.telegramUser;
        
        const { data, error } = await supabase
            .from('fundraisings')
            .insert({
                event_id,
                created_by: user.id,
                title,
                description,
                target_amount,
                current_amount: 0
            })
            .select()
            .single();
        
        if (error) {
            console.error('❌ Ошибка создания сбора:', error);
            return res.status(500).json({ error: 'Failed to create fundraising' });
        }
        
        res.status(201).json(data);
    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/fundraisings/:id/contribute', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, is_declined } = req.body;
        const user = req.telegramUser;
        
        const { data, error } = await supabase
            .from('fundraising_contributions')
            .upsert({
                fundraising_id: id,
                telegram_id: user.id,
                amount: amount || 0,
                is_declined: is_declined || false
            })
            .select()
            .single();
        
        if (error) {
            console.error('❌ Ошибка взноса:', error);
            return res.status(500).json({ error: 'Failed to contribute' });
        }
        
        res.json(data);
    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ========== ЗАПУСК ==========
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 URL: http://localhost:${PORT}`);
});
