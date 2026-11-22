# Джарвис помощник — Codex на Яндекс Станции

«Алиса, запусти навык Джарвис помощник» → «Объясни, зачем деревьям листья» → ответ Codex голосом Алисы.

Яндекс Диалоги передают распознанную реплику на Raspberry Pi. Там TypeScript-сервис отправляет её в постоянно работающий Codex App Server. У каждого Яндекс ID свой диалог, поэтому можно уточнить предыдущий ответ. Codex использует вход под аккаунтом ChatGPT и может искать в интернете. На самой Станции ничего устанавливать не нужно.

```text
Яндекс Станция → Яндекс Диалоги → HTTPS → TypeScript-сервис → Codex App Server
```

## 1. Подготовьте Raspberry Pi

Понадобятся Linux с systemd, Node.js 20+, npm, Git, OpenSSL, Codex CLI и Яндекс ID. Для подключения колонки нужен публичный HTTPS-адрес с доверенным сертификатом.

Установите Codex CLI по [инструкции OpenAI](https://learn.chatgpt.com/docs/codex/cli). Выполните команды под тем Linux-пользователем, от которого будет работать служба:

```sh
node --version
codex --version
codex login
codex login status
codex app-server --help
```

При входе выберите аккаунт ChatGPT. Для этого проекта отдельный API-ключ не нужен.

## 2. Соберите и проверьте вебхук локально

Клонируйте репозиторий или свой форк в `~/alice-codex`. Для текущего приватного репозитория нужно иметь к нему доступ.

```sh
git clone https://github.com/Maxim-Chugaev/alice-codex.git ~/alice-codex
cd ~/alice-codex
npm ci
npm run build
(umask 077; test -e webhook-token || openssl rand -hex 32 > webhook-token)
npm start
```

В отдельном терминале выполните контрольный запрос. URL передаётся в curl через stdin, чтобы секретный путь не попадал в аргументы процесса.

```sh
cd ~/alice-codex
base_url=http://127.0.0.1:8796
printf 'url = "%s/alice-codex/%s"\n' "$base_url" "$(cat webhook-token)" |
  curl -fsS --max-time 5 --config - \
    -H 'Content-Type: application/json' \
    --data '{"version":"1.0","session":{"skill_id":"local-test","session_id":"smoke","message_id":0,"application":{"application_id":"smoke"}},"request":{"type":"SimpleUtterance","command":"помощь"}}'
```

Должен вернуться JSON с подсказкой «Задайте вопрос» в `response.text`. Остановите ручной запуск через **Ctrl+C** перед включением службы.

## 3. Включите автозапуск

```sh
cd ~/alice-codex
install -m 644 dist/*.mjs .
mkdir -p ~/.config/systemd/user
install -m 644 alice-codex.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now alice-codex
systemctl --user status alice-codex --no-pager
```

Служба использует `/usr/bin/node` и ищет `codex` в своём `PATH`. Если Node.js или Codex установлены через менеджер версий, проверьте абсолютные пути через `command -v node` и `command -v codex`. Настройте `ExecStart` и переменную `CODEX_BIN` в пользовательском юните через `systemctl --user edit alice-codex`.

```ini
[Service]
ExecStart=
ExecStart=/абсолютный/путь/к/node %h/alice-codex/server.mjs
Environment=CODEX_BIN=/абсолютный/путь/к/codex
```

После изменения выполните `systemctl --user daemon-reload` и `systemctl --user restart alice-codex`.

Чтобы пользовательская служба запускалась после загрузки малинки до входа по SSH, включите linger командой `sudo loginctl enable-linger "$USER"`.

## 4. Настройте публичный HTTPS

Сервис слушает `127.0.0.1:8796`. Для прямого доступа через домашний роутер проверьте, что у роутера есть публичный WAN-адрес. Закрепите LAN-адрес малинки в DHCP и перенаправьте внешний **TCP 443** на HTTPS-прокси на малинке. **TCP 80** пригодится, если вы выпускаете и продлеваете сертификат через HTTP-01.

Пример блока Nginx для домена, который указывает на ваш WAN-адрес. Замените домен, пути к сертификату и при необходимости порт прослушивания под своё перенаправление.

```nginx
server {
    listen 443 ssl;
    server_name jarvis.example.com;

    ssl_certificate     /etc/letsencrypt/live/jarvis.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/jarvis.example.com/privkey.pem;

    access_log off;

    location ^~ /alice-codex/ {
        proxy_pass http://127.0.0.1:8796;
        proxy_connect_timeout 1s;
        proxy_read_timeout 4s;
    }

    location / {
        return 404;
    }
}
```

`proxy_pass` без URI сохраняет исходный путь запроса. После настройки проверьте конфигурацию командой `sudo nginx -t` и примените её через `sudo systemctl reload nginx`. Повторите контрольный запрос из шага 2 с `base_url=https://jarvis.example.com`, по возможности из другой сети. Яндекс требует доверенный сертификат с полной цепочкой. [Требования Яндекс Диалогов к HTTPS](https://yandex.ru/dev/dialogs/alice/doc/ru/publish-settings)

В нашем домашнем развёртывании вместо домена использовался публичный IPv4 с сертификатом Let’s Encrypt на IP. Для такого сертификата нужно настроить автоматическое продление. При смене WAN-адреса придётся выпустить сертификат для нового IP и обновить вебхук. [Сертификаты на IP в Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)

## 5. Подключите навык Яндекс Диалогов

1. Откройте [консоль Яндекс Диалогов](https://dialogs.yandex.ru/developer/). Нажмите **Создать диалог → Навык в Алисе**.
2. Задайте имя и пример активации, например **«Запусти навык Джарвис помощник»**. В типе доступа выберите **Приватный**. Добавьте **Яндекс Станцию** в доступные поверхности и выключите требование экрана.
3. В **Backend → Webhook URL** укажите `https://jarvis.example.com/alice-codex/<токен>`. Подставьте содержимое локального файла `webhook-token`. URL содержит секрет. Не публикуйте его в статье, скриншотах или журнале прокси.
4. Сохраните черновик. Во вкладке **Тестирование** включите режим **Нет экрана**, задайте вопрос и при необходимости отправьте **«Ответ»**.
5. Заполните обязательные поля публикации, включая описание и иконку. Отправьте навык на автомодерацию, нажмите **Опубликовать** и дождитесь появления опубликованной версии.
6. На Станции скажите **«Алиса, запусти навык Джарвис помощник»**. Если колонка привязана к другому Яндекс ID, выдайте этому аккаунту доступ через одноразовую ссылку во вкладке **Доступ**.

[Создание и проверка навыка](https://yandex.ru/dev/dialogs/alice/doc/ru/skill-create-console) · [Доступ к приватному навыку](https://yandex.ru/dev/dialogs/alice/doc/ru/access)

## Как работает диалог

- Первый вопрос открывает диалог. Навык сразу подтверждает приём, а Codex готовит ответ в фоне.
- В открытом диалоге навык ждёт до **3,3 секунды**. Если Codex успел, Алиса сразу озвучивает ответ. Для более долгих запросов скажите **«Ответ»** или повторите тот же вопрос. Готовый результат при повторе вопроса используется в течение **45 секунд**.
- Для свежих сведений Codex может использовать встроенный веб-поиск. Ответы с поиском обычно требуют больше времени.
- Контекст хранится в памяти фонового процесса. Перезапуск службы начинает новые диалоги. Яндекс ожидает полный ответ вебхука за **4,5 секунды**, включая сеть. [Формат ответа Алисы](https://yandex.ru/dev/dialogs/alice/doc/ru/response)

## Обновление и диагностика

```sh
cd ~/alice-codex
git pull --ff-only
npm ci
npm run build
install -m 644 dist/*.mjs .
systemctl --user restart alice-codex
journalctl --user -u alice-codex -n 30 --no-pager
```

Если в консоли работает черновик, а на колонке появляется «Навык не отвечает», проверьте URL именно **опубликованной версии** и её вкладку **Мониторинг**. Если запрос есть в журнале малинки, строки `Webhook response` и `Codex completed` показывают время ответа вебхука и длительность работы Codex.
