# Развёртывание НЕОН-ЭК на VPS (Node) + Битрикс24

Сайт — это приложение **Next.js 16** (React 19). Оно работает как Node-сервер,
поэтому ему нужен VPS с Node.js, а **не** хостинг Битрикс24. Сам Битрикс24
используется только как CRM: туда уходят заказы в виде сделок через REST API.

Каталог товаров (4751 позиция) хранится в файле `data/products.json` и
отдаётся через внутренние API-роуты. Битрикс24 на витрину товаров не влияет.

---

## 0. Порядок развёртывания: сначала внутри сети, потом наружу

Рекомендуется два этапа.

**Этап 1 — внутренний тест (LAN).**
Развернуть приложение на внутреннем сервере, запустить на порту 3000 и
проверить со всех рабочих мест в офисе по адресу `http://<IP-сервера>:3000`
(например `http://192.168.1.50:3000`). Наружу (в интернет) при этом ничего
не открывается — фаервол/роутер не пробрасывает порт. Это безопасно и
позволяет всем протестировать сайт. Для этого этапа достаточно разделов 1–5.

**Этап 2 — публикация в интернет.**
Когда внутри всё работает: поднять nginx как реверс-прокси, привязать домен
(например `shop.e-neon.ru`), выпустить TLS-сертификат (Let's Encrypt) и
открыть наружу только 80/443 порты nginx (приложение остаётся на localhost:3000).
Это разделы 6–7.

Чтобы узнать IP сервера в локальной сети: `ip a` (Linux) или `ipconfig` (Windows).

---


## 1. Требования к серверу

- Ubuntu 22.04+ (или другой Linux)
- Node.js 20 LTS или новее
- PostgreSQL 14+ (для аккаунтов, корзины, заказов)
- (опционально) nginx как реверс-прокси + TLS-сертификат
- (опционально) pnpm — проект изначально на нём, но npm тоже подойдёт

```bash
# Node 20 (через nodesource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PostgreSQL
sudo apt-get install -y postgresql

# pnpm (по желанию)
sudo npm i -g pnpm pm2
```

---

## 2. База данных

```bash
sudo -u postgres psql -c "CREATE DATABASE neon_ek;"
sudo -u postgres psql -c "CREATE USER neon WITH PASSWORD 'СВОЙ_ПАРОЛЬ';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE neon_ek TO neon;"
```

Строка подключения тогда:
`postgres://neon:СВОЙ_ПАРОЛЬ@localhost:5432/neon_ek`

---

## 3. Переменные окружения

Скопируйте `.env.example` в `.env` и заполните:

```bash
cp .env.example .env
nano .env
```

| Переменная | Назначение |
|---|---|
| `APP_URL` | Публичный адрес сайта, например `https://shop.neon-ek.ru`. Без слэша в конце. |
| `BETTER_AUTH_SECRET` | Секрет для сессий. Сгенерируйте: `openssl rand -base64 32` |
| `DATABASE_URL` | Строка подключения к PostgreSQL из шага 2 |
| `BITRIX24_WEBHOOK_URL` | Входящий вебхук Битрикс24 (см. шаг 6) |
| `PORT` | Порт Node-сервера (по умолчанию 3000) |

---

## 4. Установка и создание таблиц

```bash
pnpm install          # или: npm install
pnpm db:push          # создаёт таблицы в PostgreSQL по схеме lib/db/schema.ts
```

`db:push` применяет схему напрямую (быстро, для первого запуска).
Если нужны версионные миграции — используйте `pnpm db:generate` + `pnpm db:migrate`.

---

## 5. Сборка и запуск

```bash
pnpm build            # сборка (output: standalone)
```

Standalone-сборка кладёт самодостаточный сервер в `.next/standalone`.
Важно: статику и данные нужно скопировать рядом:

```bash
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cp -r data .next/standalone/data        # каталог товаров products.json
```

Запуск через PM2 (автоперезапуск, автозагрузка):

```bash
cd .next/standalone
PORT=3000 pm2 start server.js --name neon-ek
pm2 save
pm2 startup            # выполните команду, которую выведет pm2
```

Альтернатива без standalone — просто `pnpm start` (тоже работает, но тянет
весь node_modules; для PM2: `pm2 start "pnpm start" --name neon-ek`).

---

## 6. Настройка Битрикс24 (приём заказов)

Заказ с сайта создаёт **сделку** в Битрикс24 с товарными позициями и
контактом покупателя. Логика — в `lib/bitrix24.ts` и `app/actions/account.ts`.

Шаги в портале Битрикс24:

1. Откройте: **Приложения → Разработчикам → Другое → Входящий вебхук**.
2. Дайте права как минимум: `crm` (сделки и контакты).
   Если планируете также выгружать товары в каталог Битрикс — добавьте `catalog`.
3. Скопируйте URL вида
   `https://ВАШ-ПОРТАЛ.bitrix24.ru/rest/1/КОД/` и вставьте в `.env`
   как `BITRIX24_WEBHOOK_URL`.

Что произойдёт при оформлении заказа:
- создаётся/находится контакт по email покупателя (`crm.contact.*`);
- создаётся сделка `crm.deal.add` с суммой и комментарием (список позиций);
- товары добавляются в сделку `crm.deal.productrows.set`;
- ID сделки сохраняется в заказе (`orders.bitrixDealId`).

Если `BITRIX24_WEBHOOK_URL` не задан — заказ всё равно создаётся в БД сайта,
просто без отправки в Битрикс24 (ошибки не будет, см. `sendOrderToBitrix`).

### Обратная синхронизация статусов (опционально)
В `app/api/bitrix/webhook/route.ts` есть приёмник событий Битрикс24
(`ONCRMDEALUPDATE`). Чтобы статус заказа на сайте менялся вслед за сделкой,
настройте в Битрикс24 исходящий вебхук на событие обновления сделки,
указав адрес `https://ВАШ-САЙТ/api/bitrix/webhook`.

---

## 7. nginx + HTTPS (рекомендуется)

```nginx
server {
    server_name shop.neon-ek.ru;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Затем выпустите сертификат: `sudo certbot --nginx -d shop.neon-ek.ru`.
Убедитесь, что `APP_URL` в `.env` совпадает с `https://shop.neon-ek.ru`.

---

## 8. Обновление каталога товаров

Каталог берётся из `data/products.json` (тот самый формат, что и `price_utf8.json`).
Чтобы обновить прайс:

1. Замените `data/products.json` новым файлом (UTF-8, та же структура:
   `{ "products": [ { goodscode, name, producer2, quan_all, pricerozn,
   category, subcategory, gruppa, attributes: [{name, value}], ... } ] }`).
2. При standalone-сборке скопируйте его и в `.next/standalone/data/`.
3. Перезапустите: `pm2 restart neon-ek`.

Кэш в API сбрасывается сам в течение минуты (TTL 60 c), либо сразу после
перезапуска процесса.

---

## Частые проблемы

- **После входа сразу разлогинивает / 401** — не совпадает `APP_URL` с реальным
  адресом, или не задан `BETTER_AUTH_SECRET`. Проверьте `.env` и nginx
  `X-Forwarded-Proto`.
- **Товары не открываются (висит «Загрузка…»)** — нет `data/products.json`
  рядом с сервером (при standalone забыли скопировать `data`).
- **Заказ не появляется в Битрикс24** — проверьте `BITRIX24_WEBHOOK_URL` и права
  вебхука (`crm`). Ошибки пишутся в лог: `pm2 logs neon-ek`.
- **Сброс пароля не приходит на почту** — по умолчанию ссылка только пишется в
  лог. Подключите реальную отправку письма в `lib/auth.ts` (`sendResetPassword`).
