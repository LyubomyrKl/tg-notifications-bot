# Deploy — Hetzner single box (IPv6, polling bot, no domain)

The whole app is Dockerized. Deploy = get the repo on the box, set `.env`, run one script.
Everything runs on one VPS: `postgres` + `redis` + `api` (which embeds the delivery
and schedule workers). The bot uses **polling**, so no inbound port or domain is needed.

## 0. Is the server IPv6-only?
Hetzner charges for IPv4, so IPv6-only is common — and it needs Docker prep. On the box:
```bash
ip -4 addr show scope global | grep -q inet && echo "has IPv4" || echo "IPv6-only ⚠️"
```
**If IPv6-only**, do this once (DNS64 + NAT64 + IPv6 in Docker), else `docker pull` and
outbound-to-IPv4 will fail:
```bash
printf 'nameserver 2a01:4ff:ff00::add:1\nnameserver 2a01:4ff:ff00::add:2\n' > /etc/resolv.conf
cat > /etc/docker/daemon.json <<'EOF'
{ "ipv6": true, "fixed-cidr-v6": "fd00:dead:beef::/64", "ip6tables": true,
  "experimental": true, "dns": ["2a01:4ff:ff00::add:1","2a01:4ff:ff00::add:2"] }
EOF
systemctl restart docker
```

## 1. Server prep
```bash
ssh root@<your-ipv6>            # e.g. 2a01:4f8:c2c:1757::1
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw --force enable    # polling bot needs no other inbound port
```

## 2. Get the code on the box
Either push this repo to a git remote and clone it, **or** rsync it up:
```bash
# option A — from a git remote
git clone <your-repo-url> /opt/paedavic

# option B — from your laptop (no remote needed)
rsync -az --exclude node_modules --exclude .turbo --exclude dist ./ root@<ipv6>:/opt/paedavic/
```

## 3. Configure secrets
```bash
cd /opt/paedavic
cp .env.prod.example .env
# fill every value; generate strong ones:
#   POSTGRES_PASSWORD=$(openssl rand -hex 16)
#   SUPERADMIN_API_KEY=$(openssl rand -hex 24)
#   JWT_SECRET=$(openssl rand -hex 32)
#   TELEGRAM_BOT_TOKEN=<from BotFather>   TELEGRAM_BOT_USERNAME=<@name без @>
```

## 4. Deploy
```bash
chmod +x scripts/deploy.sh
scripts/deploy.sh     # builds, starts pg+redis+api, runs migrations, tails logs
```
Look for `Bot @<name> started (long-polling)` in the logs → it's live.

## 5. Create your first workspace (on the box)
The API is bound to `127.0.0.1:3000` (not public). Provision from the server itself:
```bash
curl -s -X POST localhost:3000/sources \
  -H "x-superadmin-key: $SUPERADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"ownerEmail":"you@ex.com","ownerPassword":"password123","name":"Prod"}'
```
Open the returned `startLink` in Telegram, press Start → you're connected.
(To call the API from your laptop instead, tunnel it: `ssh -L 3000:localhost:3000 root@<ipv6>`.)

## Redeploy (every update)
```bash
cd /opt/paedavic && scripts/deploy.sh
```

## Backups (nightly cron)
```bash
mkdir -p /opt/backups
docker compose -f /opt/paedavic/docker-compose.prod.yml exec -T postgres \
  pg_dump -U paedavic paedavic | gzip > /opt/backups/paedavic-$(date +\%F).sql.gz
```

## Ops cheatsheet
```bash
C="docker compose -f docker-compose.prod.yml"
$C ps                 # status
$C logs -f api        # live logs
$C restart api        # restart just the app
$C down               # stop everything (data survives in the pgdata volume)
```
