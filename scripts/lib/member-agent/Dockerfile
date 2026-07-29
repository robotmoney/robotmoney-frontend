# Vanilla member-agent image for the docs/architecture.md §11 onboarding eval
# (Stage 5). NO Robot Money tooling is baked in here: no `rmpc` binary, no
# @robotmoney/contract source, no onboarding knowledge of any kind. Only a
# generic OpenCode agent CLI plus the bare shell tools (curl/tar/git/jq) any of
# those would need to install `rmpc` and talk HTTP for itself — exactly what a
# real prospective member's own machine would have BEFORE following our docs.
# Everything Robot-Money-specific — installing the committee-onboarding skill,
# installing rmpc, generating keys, building + signing the canonical application
# payload, submitting it over the REST API — is something the agent inside the
# container must work out at runtime from the injected canonical prompt
# (contract's ONBOARDING_PROMPT text, with the skill URL pointed locally by
# scripts/lib/onboarding-eval.ts) plus the committee-onboarding skill it
# installs (D21 — the MCP transport is retired; the agent uses plain HTTP). A
# failure to figure any of this out is a valid (red) eval result about our
# instructions, not a bug in this image.
#
# Pinned opencode release + checksum, independently verified against the
# upstream release asset.
ARG OPENCODE_VERSION=1.18.1
ARG OPENCODE_LINUX_X64_SHA256=9ecce27cf529ade5f177fab478b4876b5c31d9ddc8216b994816acf192159511

FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar git jq bash \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION
ARG OPENCODE_LINUX_X64_SHA256
RUN curl -fsSLo /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
    && echo "${OPENCODE_LINUX_X64_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin \
    && rm /tmp/opencode.tar.gz

# rmpc is installed by the AGENT itself at runtime (the "toolchain" step of
# docs/architecture.md §11.2) via GitHub Releases egress — never by this image.
# A writable dir on PATH so the agent's own `curl | tar -C ... ` install lands
# somewhere it can execute rmpc from without root.
#
# HOME must agree with that dir. The container runs as root, so without this
# `~` is /root while PATH advertises /home/agent/.local/bin — and the repo-owned
# committee-onboarding skill's own copy-paste install line,
# `install -m 755 rmpc ~/.local/bin/rmpc`, then puts the binary somewhere PATH
# does not look. Observed live: the agent ran exactly that line, got
# `rmpc: command not found`, and had to spend turns rediscovering where its own
# install went. That friction is this image's, not our documentation's, and the
# eval is only allowed to report on the latter.
ENV HOME="/home/agent"
RUN mkdir -p /home/agent/.local/bin \
    && git config --global user.email "member-agent@robotmoney.invalid" \
    && git config --global user.name "member-agent" \
    && git init -q /home/agent
ENV PATH="/home/agent/.local/bin:${PATH}"
WORKDIR /home/agent

ENTRYPOINT ["opencode"]
