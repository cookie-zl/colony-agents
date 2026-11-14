{{/* 名称与标签 */}}
{{- define "colony-agents.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "colony-agents.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "colony-agents.selectorLabels" -}}
app.kubernetes.io/name: {{ include "colony-agents.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "colony-agents.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "colony-agents.selectorLabels" . }}
app.kubernetes.io/component: web
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* 镜像引用：digest 优先 */}}
{{- define "colony-agents.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{/* 模型凭据的 Secret 名 */}}
{{- define "colony-agents.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secret" (include "colony-agents.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* 浏览器可见地址：没显式给就用 ingress 拼 */}}
{{- define "colony-agents.publicUrl" -}}
{{- if .Values.dsh.publicUrl -}}
{{- .Values.dsh.publicUrl -}}
{{- else if .Values.ingress.enabled -}}
{{- printf "%s://%s/" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- else -}}
{{- printf "http://127.0.0.1:%v/" .Values.service.port -}}
{{- end -}}
{{- end -}}
