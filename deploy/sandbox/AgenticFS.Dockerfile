FROM fc-e2b-registry.cn-shanghai.cr.aliyuncs.com/runtime/code-interpreter-v1:v0.0.49

# Equivalent client installation was cloud-built and executed in template
# u3sxwxk9b0l0tiphkt32. Do not embed cloud credentials in this image.
ARG ALINAS_DEB_URL=https://aliyun-alinas-eac-cn-hangzhou.oss-cn-hangzhou.aliyuncs.com/aliyun-alinas-utils_2.4-0.20260908115139.ac23e3.amd64.deb
ARG ALINAS_DEB_SHA256=e0866d4a4a8b9fa7dbb3b0dea8ee086e7c8bfe3e79160a5e415935a86ec3367d
RUN sudo bash -eu -c ' \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl nfs-common; \
    curl -fL "$1" -o /tmp/alinas.deb; \
    echo "$2  /tmp/alinas.deb" | sha256sum -c -; \
    apt-get install -y /tmp/alinas.deb; \
    rm -f /tmp/alinas.deb; \
    command -v mount.alinas; \
    command -v mount.nfs \
    ' -- "${ALINAS_DEB_URL}" "${ALINAS_DEB_SHA256}"
