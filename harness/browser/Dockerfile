# Reproducible environment for the Risk-B browser probes.
#
# Why a container: the host's package state is not persistent, so chromium /
# ffmpeg / Xvfb installed with the system package manager vanish on every host
# update -- taking every measurement's reproducibility with them. Everything
# the probes need is pinned here instead.
FROM node:26-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      xvfb \
      x11-utils \
      fonts-liberation \
      ca-certificates \
      procps \
    && rm -rf /var/lib/apt/lists/*

# Headful-under-Xvfb is not optional: headless Chrome does not background
# renderers, so every timer-throttling number taken in it is unfalsifiable.
# See docs/BROWSER-FINDINGS.md section 4.
ENV DISPLAY=:99
ENV CHROME_BIN=/usr/bin/chromium

WORKDIR /work/harness/browser

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
