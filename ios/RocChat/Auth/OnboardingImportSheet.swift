import SwiftUI

struct OnboardingImportSheet: View {
    let onDismiss: () -> Void
    @State private var importing = false
    @State private var importDone = false
    @State private var selectedSource: String? = nil
    
    private let sources = [
        ("WhatsApp", "message.fill", "Import chats from WhatsApp backup"),
        ("Telegram", "paperplane.fill", "Import from Telegram export"),
        ("Signal", "lock.shield.fill", "Import from Signal backup"),
    ]
    
    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Image(systemName: "square.and.arrow.down.on.square.fill")
                    .font(.system(size: 48))
                    .foregroundColor(.rocGold)
                
                Text("Import Your Chats")
                    .font(.title2.bold())
                    .foregroundColor(.textPrimary)
                
                Text("Bring your conversations from other messaging apps. You can always do this later from Settings.")
                    .font(.subheadline)
                    .foregroundColor(.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                
                VStack(spacing: 12) {
                    ForEach(sources, id: \.0) { source in
                        Button {
                            selectedSource = source.0
                            importing = true
                            // Simulate import — real import would use file picker
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                importing = false
                                importDone = true
                            }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: source.1)
                                    .foregroundColor(.rocGold)
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(source.0)
                                        .fontWeight(.semibold)
                                        .foregroundColor(.textPrimary)
                                    Text(source.2)
                                        .font(.caption)
                                        .foregroundColor(.textSecondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .foregroundColor(.textSecondary)
                            }
                            .padding()
                            .background(Color.bgCard)
                            .cornerRadius(12)
                        }
                        .disabled(importing)
                    }
                }
                .padding(.horizontal)
                
                if importing {
                    ProgressView("Importing from \(selectedSource ?? "")...")
                        .foregroundColor(.textSecondary)
                }
                
                if importDone {
                    Label("Import complete!", systemImage: "checkmark.circle.fill")
                        .foregroundColor(.turquoise)
                }
                
                Spacer()
                
                Button(action: onDismiss) {
                    Text(importDone ? "Continue" : "Skip for now")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(importDone ? Color.rocGold : Color.bgCard)
                        .foregroundColor(importDone ? .midnightAzure : .textSecondary)
                        .cornerRadius(8)
                }
                .padding(.horizontal)
                .padding(.bottom)
            }
            .padding(.top, 32)
            .background(Color.midnightAzure.ignoresSafeArea())
            .navigationBarHidden(true)
        }
    }
}
