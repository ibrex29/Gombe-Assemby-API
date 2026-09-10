#!/bin/sh
set -e

CONFIG="${ALERTMANAGER_CONFIG:-/tmp/alertmanager.yml}"
WEBHOOK="${ALERT_WEBHOOK_URL:-http://127.0.0.1:65535/alert}"
SLACK_URL="${ALERT_SLACK_WEBHOOK_URL:-}"
SLACK_CHANNEL="${ALERT_SLACK_CHANNEL:-#electromon-alerts}"

slack_block=""
if [ -n "$SLACK_URL" ]; then
  slack_block=$(cat <<EOF
    slack_configs:
      - api_url: '${SLACK_URL}'
        channel: '${SLACK_CHANNEL}'
        send_resolved: true
        title: '[Electromon] {{ .Status | toUpper }} {{ .CommonLabels.alertname }}'
        text: '{{ range .Alerts }}*{{ .Labels.severity }}* {{ .Annotations.summary }}{{ end }}'
EOF
)
fi

cat > "$CONFIG" <<EOF
global:
  resolve_timeout: 5m

route:
  receiver: default
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - match:
        severity: critical
      receiver: critical

receivers:
  - name: default
    webhook_configs:
      - url: '${WEBHOOK}'
        send_resolved: true
${slack_block}
  - name: critical
    webhook_configs:
      - url: '${WEBHOOK}'
        send_resolved: true
${slack_block}

inhibit_rules:
  - source_match:
      severity: critical
    target_match:
      severity: warning
    equal: ['alertname']
EOF

exec /bin/alertmanager "$@"
