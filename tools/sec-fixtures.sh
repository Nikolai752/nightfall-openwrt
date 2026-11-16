#!/bin/sh
# Заглушки роутера для проверок nightfall-sec: sh tools/sec-fixtures.sh КАТАЛОГ (T=каталог)
T=${1:-$T}
cat > "$T/log.txt" <<'L'
Mon Nov 16 02:10:01 2026 authpriv.warn dropbear[111]: Bad password attempt for 'root' from 203.0.113.5:40022
Mon Nov 16 02:10:05 2026 authpriv.warn dropbear[112]: Bad password attempt for 'admin' from 203.0.113.5:40023
Mon Nov 16 02:10:09 2026 authpriv.warn dropbear[113]: Login attempt for nonexistent user from 198.51.100.7:5000
Mon Nov 16 02:11:00 2026 authpriv.notice dropbear[114]: Password auth succeeded for 'root' from 192.168.1.10:50000
Mon Nov 16 02:12:00 2026 authpriv.info luci: failed login on / for root from 203.0.113.9
Mon Nov 16 02:13:00 2026 authpriv.info luci: accepted login on / for root from 192.168.1.10
Mon Nov 16 02:14:00 2026 daemon.info something: unrelated
L
printf '#!/bin/sh\ncat %s\n' "$T/log.txt" > "$T/logread"; chmod +x "$T/logread"

# /proc: слушают sshd на всех адресах, uhttpd на всех, служба только на 127.0.0.1, UDP dns
mkdir -p "$T/proc/net" "$T/proc/201/fd" "$T/proc/202/fd"
cat > "$T/proc/net/tcp" <<'P'
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5001 1 0 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5002 1 0 100 0 0 10 0
   2: 0100A8C0:C350 0100A8C0:0050 01 00000000:00000000 00:00000000 00000000     0        0 5003 1 0 100 0 0 10 0
P
cat > "$T/proc/net/tcp6" <<'P'
  sl  local_address rem_address   st
   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5004 1 0 100 0 0 10 0
P
cat > "$T/proc/net/udp" <<'P'
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 5005 2 0
P
: > "$T/proc/net/udp6"
echo dropbear > "$T/proc/201/comm"; ln -s 'socket:[5001]' "$T/proc/201/fd/3"
echo uhttpd > "$T/proc/202/comm"; ln -s 'socket:[5004]' "$T/proc/202/fd/4"

printf 'aa:bb:cc:dd:ee:01|Телефон|1700000000\naa:bb:cc:dd:ee:02|Камера|1700001000\n' > "$T/known"
cat > "$T/uci" <<'U'
#!/bin/sh
case "$*" in
*"show wireless"*) cat <<'W'
wireless.cfgA=wifi-iface
wireless.cfgA.mode='ap'
wireless.cfgA.ssid='Home'
wireless.cfgA.encryption='sae-mixed'
wireless.cfgB=wifi-iface
wireless.cfgB.mode='ap'
wireless.cfgB.ssid='Guest'
wireless.cfgB.encryption='none'
wireless.cfgC=wifi-iface
wireless.cfgC.mode='ap'
wireless.cfgC.ssid='Old'
wireless.cfgC.encryption='psk+tkip'
wireless.cfgD=wifi-iface
wireless.cfgD.disabled='1'
wireless.cfgD.mode='ap'
wireless.cfgD.ssid='Off'
wireless.cfgD.encryption='none'
W
exit 0 ;;
*redirect_https*) exit 0 ;;
*PasswordAuth*) echo 0; exit 0 ;;
esac
cat <<'X'
firewall.cfg1=zone
firewall.cfg1.name='wan'
firewall.cfg1.input='REJECT'
firewall.cfg2=redirect
firewall.cfg2.name='Web'
firewall.cfg2.src='wan'
firewall.cfg2.proto='tcp'
firewall.cfg2.src_dport='8080'
firewall.cfg2.dest_ip='192.168.1.5'
firewall.cfg2.dest_port='80'
firewall.cfg2.target='DNAT'
firewall.cfg3=redirect
firewall.cfg3.name='Off'
firewall.cfg3.enabled='0'
firewall.cfg3.src='wan'
firewall.cfg3.src_dport='9999'
firewall.cfg3.dest_port='1'
X
U
chmod +x "$T/uci"
printf 'daemon:*::0:::::\nroot::0:0:99999:7:::\n' > "$T/shadow"
printf '#!/bin/sh\necho "{\\"installed\\":\\"1.0.0\\",\\"latest\\":\\"1.1.0\\",\\"new\\":1}"\n' > "$T/upd"; chmod +x "$T/upd"


# nft-заглушка для проверки закрытия адресов
cat > "$T/nft" <<'N'
#!/bin/sh
LOG=${NFT_LOG:-/dev/null}
echo "$*" >> "$LOG"
case "$1 $2" in
"-f -") cat >> "$LOG"; touch "$LOG.on" ;;
"list table") [ -f "$LOG.on" ] && echo "ip saddr @b4 drop" ;;
"list set") case "$5" in b4) printf 'table inet nightfall_ban {\n\tset b4 {\n\t\ttype ipv4_addr\n\t\tflags timeout\n\t\telements = { 203.0.113.5 timeout 1d expires 23h59m10s,\n\t\t\t     198.51.100.7 timeout 1h expires 59m1s }\n\t}\n}\n' ;; esac ;;
esac
exit 0
N
chmod +x "$T/nft"
# журнал DNS (dnsmasq с logqueries)
cat > "$T/dnslog.txt" <<'L'
Mon Nov 16 02:10:01 2026 daemon.info dnsmasq[1]: query[A] www.youtube.com from 192.168.1.10
Mon Nov 16 02:10:01 2026 daemon.info dnsmasq[1]: forwarded www.youtube.com to 1.1.1.1
Mon Nov 16 02:10:02 2026 daemon.info dnsmasq[1]: query[AAAA] r1.googlevideo.com from 192.168.1.10
Mon Nov 16 02:10:03 2026 daemon.info dnsmasq[1]: query[A] m.youtube.com from 192.168.1.11
Mon Nov 16 02:10:04 2026 daemon.info dnsmasq[1]: query[A] bbc.co.uk from 192.168.1.11
Mon Nov 16 02:10:05 2026 daemon.info dnsmasq[1]: query[A] nope.example.org from 192.168.1.11
Mon Nov 16 02:10:05 2026 daemon.info dnsmasq[1]: reply nope.example.org is NXDOMAIN
Mon Nov 16 02:10:06 2026 daemon.info dnsmasq[1]: query[A] nope.example.org from 192.168.1.10
Mon Nov 16 02:10:06 2026 daemon.info dnsmasq[1]: config nope.example.org is NXDOMAIN
Mon Nov 16 02:10:07 2026 authpriv.warn dropbear[5]: query[A] fake.test from 1.2.3.4
L
printf '#!/bin/sh\ncat %s\n' "$T/dnslog.txt" > "$T/dnslogread"; chmod +x "$T/dnslogread"
printf '#!/bin/sh\n[ "$2" = "dhcp.@dnsmasq[0].logqueries" ] && echo 1\n' > "$T/uci_dns"; chmod +x "$T/uci_dns"
