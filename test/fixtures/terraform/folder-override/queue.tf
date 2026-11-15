resource "aws_sqs_queue" "orders" {
  visibility_timeout_seconds = 600
}
