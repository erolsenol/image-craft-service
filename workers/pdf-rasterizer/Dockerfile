FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --create-home pdfworker

WORKDIR /app
COPY app.py ./app.py
USER 10001:10001
EXPOSE 8000
CMD ["python", "-u", "app.py"]
