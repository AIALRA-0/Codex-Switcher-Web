FROM node:22-bookworm-slim AS node-runtime

FROM codercom/code-server:4.103.2

USER root

ENV CODE_SERVER_OPENAI_EXTENSION_ID=openai.chatgpt

COPY --from=node-runtime /usr/local /usr/local

RUN npm install -g @openai/codex@0.116.0 \
  && mkdir -p /workspace /home/coder/.codex /home/coder/.config/code-server /home/coder/.local/share/code-server/extensions \
  && chown -R coder:coder /workspace /home/coder/.codex /home/coder/.config /home/coder/.local

COPY --chown=coder:coder deploy/code-server/start-code-server.sh /usr/local/bin/start-code-server.sh
RUN chmod +x /usr/local/bin/start-code-server.sh

USER coder

RUN code-server --install-extension "${CODE_SERVER_OPENAI_EXTENSION_ID}" --force

WORKDIR /workspace

CMD ["/usr/local/bin/start-code-server.sh"]
