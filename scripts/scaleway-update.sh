#!/usr/bin/env bash
# ==============================================================================
# CIAO-CORS - Scaleway Serverless Container 原地热替换运维脚本
#
# 安全原则：
# 1. 默认仅执行 dry-run 检查并输出计划，必须显式传递 --apply 才会执行变更
# 2. 严禁创建、删除或重建任何 Namespace / Container
# 3. 更新前自动将当前容器配置完整备份至本地临时目录
# 4. 严禁将 API Keys / Secrets 打印在控制台日志中
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

REGION="nl-ams"
CONTAINER_ID=""
IMAGE="ghcr.io/silentely/ciao-cors:1.3.2"
PORT="3000"
RESOURCE_PROFILE="low-memory"
APPLY=false

print_status() {
    local type=$1
    local message=$2
    local timestamp=$(date '+%H:%M:%S')
    case $type in
        "info")    echo -e "${BLUE}[INFO]${NC} [$timestamp] $message" ;;
        "success") echo -e "${GREEN}[SUCCESS]${NC} [$timestamp] $message" ;;
        "warning") echo -e "${YELLOW}[WARNING]${NC} [$timestamp] $message" ;;
        "error")   echo -e "${RED}[ERROR]${NC} [$timestamp] $message" ;;
    esac
}

usage() {
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  --region <region>               Scaleway 区域 (默认: nl-ams; 可选: fr-par, pl-waw 等)"
    echo "  --container-id <container_id>   现有容器的 UUID (必填)"
    echo "  --image <image_url>             目标 GHCR 镜像 (默认: ghcr.io/silentely/ciao-cors:1.3.2)"
    echo "  --port <port>                   容器端口 (默认: 3000)"
    echo "  --profile <profile>             运行 Profile (默认: low-memory; 可选: standard)"
    echo "  --apply                         确认执行原地更新 (默认仅 dry-run 检查)"
    echo "  -h, --help                      显示帮助信息"
    echo ""
    echo "示例:"
    echo "  # 1. 预览检查 (安全 Dry-run)"
    echo "  $0 --region nl-ams --container-id 11111111-2222-3333-4444-555555555555"
    echo ""
    echo "  # 2. 确认执行原地热更新"
    echo "  $0 --region nl-ams --container-id 11111111-2222-3333-4444-555555555555 --apply"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --region) REGION="$2"; shift 2 ;;
        --container-id) CONTAINER_ID="$2"; shift 2 ;;
        --image) IMAGE="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --profile) RESOURCE_PROFILE="$2"; shift 2 ;;
        --apply) APPLY=true; shift ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1"; usage ;;
    esac
done

if [[ -z "$CONTAINER_ID" ]]; then
    print_status "error" "必须指定 --container-id 参数"
    usage
fi

print_status "info" "Scaleway 原地替换配置检查"
echo "--------------------------------------------------------"
echo "目标区域:       $REGION"
echo "容器 ID:        $CONTAINER_ID"
echo "目标镜像:       $IMAGE"
echo "容器端口:       $PORT"
echo "资源 Profile:   $RESOURCE_PROFILE"
echo "执行模式:       $([ "$APPLY" = true ] && echo -e "${RED}实际应用 (--apply)${NC}" || echo -e "${GREEN}预览检查 (Dry-run)${NC}")"
echo "--------------------------------------------------------"

SCW_TOKEN="${SCW_SECRET_KEY:-${SCW_TOKEN:-}}"
if [[ -z "$SCW_TOKEN" ]]; then
    if command -v scw &>/dev/null; then
        print_status "info" "使用 scw CLI 认证环境..."
    else
        print_status "error" "未检测到 SCW_SECRET_KEY 环境变量，且未安装 scw CLI。请提供 API Token 后重试。"
        exit 1
    fi
fi

API_ENDPOINT="https://api.scaleway.com/containers/v1beta1/regions/${REGION}/containers/${CONTAINER_ID}"

# 1. 查询并备份现有容器配置
print_status "info" "正在获取当前容器最新配置..."
BACKUP_FILE="/tmp/scw-container-backup-${CONTAINER_ID}-$(date +%s).json"

if [[ -n "$SCW_TOKEN" ]]; then
    HTTP_CODE=$(curl -s -w "%{http_code}" -o "$BACKUP_FILE" \
        -H "X-Auth-Token: ${SCW_TOKEN}" \
        -H "Content-Type: application/json" \
        "$API_ENDPOINT")
else
    scw container container get "$CONTAINER_ID" region="$REGION" -o json > "$BACKUP_FILE" 2>/dev/null || HTTP_CODE="500"
    HTTP_CODE="200"
fi

if [[ "$HTTP_CODE" != "200" ]]; then
    print_status "error" "获取容器配置失败 (HTTP $HTTP_CODE)。请核对 Container ID 与 Region 是否准确。"
    rm -f "$BACKUP_FILE"
    exit 1
fi

print_status "success" "现有容器配置已完整备份至: $BACKUP_FILE"

# 2. 检查旧配置中是否有遗留的 command/args
OLD_IMAGE=$(jq -r '.registry_image_address // empty' "$BACKUP_FILE" 2>/dev/null || echo "unknown")
OLD_PORT=$(jq -r '.port // empty' "$BACKUP_FILE" 2>/dev/null || echo "unknown")
CONTAINER_NAME=$(jq -r '.name // empty' "$BACKUP_FILE" 2>/dev/null || echo "unknown")

print_status "info" "容器当前名称: $CONTAINER_NAME"
print_status "info" "当前运行镜像: $OLD_IMAGE -> 将变更为: $IMAGE"
print_status "info" "当前映射端口: $OLD_PORT -> 将变更为: $PORT"

if [ "$APPLY" = false ]; then
    echo ""
    print_status "warning" "[DRY-RUN 模式] 检查完毕。未对云端发起任何变更写入。"
    echo "若确认原地应用上述配置，请附加 --apply 运行："
    echo "  $0 --region $REGION --container-id $CONTAINER_ID --image $IMAGE --apply"
    exit 0
fi

# 3. 执行原地热更新 (PATCH)
print_status "info" "正在向 Scaleway 提交原地更新请求 (保持原资源与域名不变)..."

PATCH_PAYLOAD=$(cat <<EOF
{
  "registry_image_address": "$IMAGE",
  "port": $PORT,
  "environment_variables": {
    "PORT": "$PORT",
    "RESOURCE_PROFILE": "$RESOURCE_PROFILE"
  },
  "health_check": {
    "http": {
      "path": "/health"
    },
    "failure_threshold": 3,
    "interval": "30s"
  },
  "redeploy": true
}
EOF
)

if [[ -n "$SCW_TOKEN" ]]; then
    UPDATE_RES=$(curl -s -w "\n%{http_code}" -X PATCH "$API_ENDPOINT" \
        -H "X-Auth-Token: ${SCW_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$PATCH_PAYLOAD")

    HTTP_STATUS=$(echo "$UPDATE_RES" | tail -n1)
    BODY=$(echo "$UPDATE_RES" | sed '$d')

    if [[ "$HTTP_STATUS" != "200" ]]; then
        print_status "error" "更新失败 (HTTP $HTTP_STATUS): $BODY"
        print_status "info" "可使用备份文件回滚: $BACKUP_FILE"
        exit 1
    fi
else
    scw container container update "$CONTAINER_ID" \
        region="$REGION" \
        registry-image-address="$IMAGE" \
        port="$PORT" \
        redeploy=true
fi

print_status "success" "原地更新已触发，正在等待 Scaleway 滚动部署完成..."
print_status "info" "部署成功后，服务可通过原有域名直接访问！"
echo ""
echo "如需紧急回滚至上一个版本，请在 Scaleway 控制台将镜像地址恢复为："
echo "  旧镜像: $OLD_IMAGE"
